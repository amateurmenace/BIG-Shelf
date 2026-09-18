import { InviteStatuses } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import {
  data,
  redirect,
  Form,
  useActionData,
  useLoaderData,
} from "react-router";
import { z } from "zod";
import Input from "~/components/forms/input";
import PasswordInput from "~/components/forms/password-input";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { useSearchParams } from "~/hooks/search-params";
import { useDisabled } from "~/hooks/use-disabled";
import { signInWithEmail } from "~/modules/auth/service.server";
import { generateRandomCode } from "~/modules/invite/helpers";
import {
  checkUserAndInviteMatch,
  updateInviteStatus,
} from "~/modules/invite/service.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie } from "~/utils/cookies.server";
import { INVITE_TOKEN_SECRET, SUPPORT_EMAIL } from "~/utils/env";
import {
  isZodValidationError,
  makeShelfError,
  ShelfError,
} from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import {
  payload,
  error,
  getParams,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import jwt from "~/utils/jsonwebtoken.server";
import { resolveUserDisplayName } from "~/utils/user";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const { inviteId } = getParams(params, z.object({ inviteId: z.string() }), {
    additionalData: { inviteId: params.inviteId },
  });
  try {
    /** We get the invite based on the id of the params */
    const invite = await db.invite
      .findFirstOrThrow({
        // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: pre-org invite-acceptance flow; the viewer is not yet a member of the org, so there is no caller organizationId to scope by — the invite record itself establishes the org relationship (and authenticated users are additionally validated via checkUserAndInviteMatch below)
        where: {
          id: inviteId,
        },
        include: {
          organization: {
            select: {
              name: true,
            },
          },
          inviter: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
            },
          },
        },
      })
      .catch((cause) => {
        throw new ShelfError({
          cause,
          title: "Invite not found",
          message:
            "The invitation you are trying to accept is either not found or expired",
          label: "Invite",
        });
      });

    /** Here we have to do a check based on the session of the current user
     * If the user is already signed in, we have to make sure the invite sent, is for the same user
     */
    if (context.isAuthenticated) {
      await checkUserAndInviteMatch({
        context,
        invite,
      });
    }

    // BIG: a brand-new invitee (unauthenticated, no existing account) gets a
    // "create your password" form so they set a real password up front — instead
    // of being silently provisioned with a random one they never see (which left
    // them unable to log in later and hunting for the tiny "Sign up" link).
    const existingUser = await db.user.findFirst({
      where: { email: invite.inviteeEmail },
      select: { id: true },
    });
    const needsPassword = !context.isAuthenticated && !existingUser;

    return payload({
      inviter: resolveUserDisplayName(invite.inviter),
      workspace: `${invite.organization.name}`,
      inviteeEmail: invite.inviteeEmail,
      needsPassword,
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(
      error({ ...reason, title: reason.title || "Accept team invite" }),
      {
        status: reason.status,
      }
    );
  }
}

export const meta = () => [{ title: appendToMetaTitle("Accept team invite") }];

/**
 * Accept-invite form data. `token` always comes from the invite link.
 * `password`/`confirmPassword` are present only on the new-invitee "create your
 * password" path; when absent (authenticated / already-registered user) a random
 * password is used and never surfaced.
 */
const AcceptInviteSchema = z
  .object({
    token: z.string(),
    password: z
      .string()
      .min(8, "Your password is too short. Min 8 characters are required.")
      .optional(),
    confirmPassword: z.string().optional(),
  })
  .superRefine(({ password, confirmPassword }, ctx) => {
    if (password && password !== confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Password and confirm password must match",
        path: ["confirmPassword"],
      });
    }
  });

export async function action({ context, request }: LoaderFunctionArgs) {
  try {
    const { token, password: chosenPassword } = parseData(
      await request.formData(),
      AcceptInviteSchema,
      {
        message:
          "The invitation link doesn't have a token provided. Please try clicking the link in your email again or request a new invite. If the issue persists, feel free to contact support",
      }
    );

    const decodedInvite = jwt.verify(token, INVITE_TOKEN_SECRET) as {
      id: string;
    };

    // BIG: a brand-new invitee MUST set a real password here — they're now
    // provisioned as `onboarded` and never prompted again, so a submit that
    // slipped past the form's `required` (JS disabled / crafted request) would
    // otherwise be given an unknowable random password and be locked out. Mirror
    // the loader's `needsPassword` check server-side and reject before we
    // provision anything. Only runs on the rare no-password submit.
    if (!context.isAuthenticated && !chosenPassword) {
      const invite = await db.invite.findFirst({
        // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: pre-org invite-acceptance flow; the invite id comes from the JWT-verified token above and the viewer is not yet a member of any org, so there is no caller organizationId to scope by — this only reads inviteeEmail to decide whether a password is required (mirrors the loader's own invite lookup)
        where: { id: decodedInvite.id },
        select: { inviteeEmail: true },
      });
      const alreadyRegistered = invite
        ? Boolean(
            await db.user.findFirst({
              where: { email: invite.inviteeEmail },
              select: { id: true },
            })
          )
        : true; // no invite found → let updateInviteStatus surface the real error
      if (!alreadyRegistered) {
        throw new ShelfError({
          cause: null,
          title: "Password required",
          message:
            "Please choose a password to finish setting up your account, then try again.",
          label: "Invite",
          status: 400,
          shouldBeCaptured: false,
        });
      }
    }

    // BIG: use the invitee's chosen password (new-user path) so they can log in
    // afterwards; otherwise a random one (authenticated / already-registered
    // path, where createUserOrAttachOrg ignores it).
    const password = chosenPassword || generateRandomCode(10);
    const updatedInvite = await updateInviteStatus({
      id: decodedInvite.id,
      status: InviteStatuses.ACCEPTED,
      password,
    });

    if (updatedInvite.status !== InviteStatuses.ACCEPTED) {
      throw new ShelfError({
        cause: null,
        message:
          "Something went wrong with updating your invite. Please try again",
        label: "Invite",
      });
    }

    /** If the user is already signed in, we jus redirect them to assets index and set */
    if (context.isAuthenticated) {
      return redirect(safeRedirect(`/assets`), {
        headers: [
          setCookie(
            await setSelectedOrganizationIdCookie(updatedInvite.organizationId)
          ),
        ],
      });
    }

    /** Sign in the user */
    const authSession = await signInWithEmail(
      updatedInvite.inviteeEmail,
      password
    ).catch(
      // We don't care about the error here, let the user login if he's already registered
      () => null
    );

    /**
     * User could already be registered and hence login in with our password failed,
     * redirect to home and let user login or go to home */
    if (!authSession) {
      return redirect("/login?acceptedInvite=yes");
    }

    // Commit the session
    context.setSession(authSession);

    // BIG: a brand-new invitee is now fully provisioned (real password + name)
    // and marked onboarded in createUser, so send them straight to /home. Going
    // via /onboarding would only redirect back to /home (onboarded guard) after
    // pointlessly re-asking for a password and their name. /home routes members
    // to /reserve and everyone else to their dashboard.
    return redirect(safeRedirect(`/home`), {
      headers: [
        setCookie(
          await setSelectedOrganizationIdCookie(updatedInvite.organizationId)
        ),
      ],
    });
  } catch (cause) {
    const reason = makeShelfError(
      cause,
      undefined,
      isZodValidationError(cause)
    );
    let titleOverride = null;
    if (cause instanceof Error && cause.name === "JsonWebTokenError") {
      titleOverride = "Invalid invite token";
      reason.message =
        "The invitation link is invalid. Please try clicking the link in your email again or request a new invite. If the issue persists, feel free to contact support";
    }

    return data(
      error({
        ...reason,
        title: titleOverride ?? (reason.title || "Accept team invite"),
      }),
      {
        status: reason.status,
      }
    );
  }
}

/**
 * Splits a multi-line error message into objects with stable, position-based
 * ids so the rendered list has unique keys that don't depend on the array
 * index expression (satisfies react-doctor/no-array-index-as-key).
 */
function splitIntoStableLines(message: string) {
  let offset = 0;
  return message.split("\n").map((content) => {
    const id = `line-${offset}`;
    offset += content.length + 1;
    return { id, content };
  });
}

export default function AcceptInvite() {
  const { inviter, workspace, inviteeEmail, needsPassword } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const disabled = useDisabled();
  const actionData = useActionData<typeof action>();
  const error = actionData?.error;
  /** Server-side validation fallback (client validation can be bypassed). */
  const validationErrors = getValidationErrors<typeof AcceptInviteSchema>(
    actionData?.error
  );
  return (
    <>
      <div className=" flex flex-col items-center text-center">
        {error ? (
          <div>
            <h2>{error.title}</h2>
            {/*
             * Render the error message as text (not HTML) to avoid any XSS
             * surface. Newlines are preserved via <br/> so multi-line error
             * copy keeps its visual structure.
             */}
            <p className="mx-4 mb-3 mt-2 md:mx-[-200px]">
              {splitIntoStableLines(error.message).map((line, i) => (
                <span key={line.id}>
                  {i > 0 && <br />}
                  {line.content}
                </span>
              ))}
            </p>
            <Button to="/" variant={"secondary"}>
              Back to home
            </Button>
          </div>
        ) : needsPassword ? (
          <div className="w-full text-left">
            <h2 className="text-center">Accept your invite</h2>
            <p className="mb-5 mt-2 text-center text-gray-600">
              <strong>{inviter}</strong> invited you to join{" "}
              <strong>{workspace}’s</strong> workspace. Create a password to
              finish setting up your account.
            </p>
            <Form method="post" className="space-y-4">
              <input
                type="hidden"
                name="token"
                value={searchParams.get("token") || ""}
              />
              <Input
                label="Email"
                name="email"
                defaultValue={inviteeEmail}
                disabled
                inputClassName="w-full"
              />
              <PasswordInput
                label="Create a password"
                name="password"
                required
                autoComplete="new-password"
                /* why: a "**********" placeholder is visually identical to a
                   filled-in password field, so invitees believed a password
                   had already been set for them and submitted nothing. */
                placeholder="At least 8 characters"
                inputClassName="w-full"
                error={validationErrors?.password?.message}
              />
              <PasswordInput
                label="Confirm password"
                name="confirmPassword"
                required
                autoComplete="new-password"
                placeholder="Re-type your password"
                inputClassName="w-full"
                error={validationErrors?.confirmPassword?.message}
              />
              <Button type="submit" width="full" disabled={disabled}>
                {disabled
                  ? "Creating your account..."
                  : "Create account & join"}
              </Button>
            </Form>
          </div>
        ) : (
          <div>
            <h2>Accept invite</h2>
            <p className="mt-2">
              <strong>{inviter}</strong> invites you to join Shelf as a member
              of <strong>{workspace}’s</strong> workspace.
            </p>
            <Form method="post" className="my-3">
              <input
                type="hidden"
                name="token"
                value={searchParams.get("token") || ""}
              />

              <Button type="submit" disabled={disabled || error}>
                {disabled ? "Validating token..." : "Accept invite"}
              </Button>
            </Form>
          </div>
        )}
      </div>
      <div className=" mx-4 mt-20 flex flex-col items-center text-center text-gray-600 md:mx-[-200px]">
        <p>
          If you have any questions or need assistance, please don't hesitate to
          contact our support team at{" "}
          <Button variant={"link-gray"} to={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </Button>
          .
        </p>
      </div>
    </>
  );
}
