import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { useZorm } from "react-zorm";
import { z } from "zod";
import { SocialLoginButtons } from "~/components/big/social-login-buttons";
import { Form } from "~/components/custom-form";

import Input from "~/components/forms/input";
import PasswordInput from "~/components/forms/password-input";
import { Button } from "~/components/shared/button";
import { config } from "~/config/shelf.config";
import { useSearchParams } from "~/hooks/search-params";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { isNeonOAuthConfigured } from "~/integrations/neon-crm/client.server";
import { signInWithEmail } from "~/modules/auth/service.server";

import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie } from "~/utils/cookies.server";
import { ENABLE_GOOGLE_LOGIN, ENABLE_MICROSOFT_LOGIN } from "~/utils/env";
import {
  ShelfError,
  isLikeShelfError,
  isZodValidationError,
  makeShelfError,
  notAllowedMethod,
} from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import {
  payload,
  error,
  getActionMethod,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import { validEmail } from "~/utils/misc";

export function loader({ context }: LoaderFunctionArgs) {
  const title = "Log in";
  const subHeading = "Welcome back! Enter your details below to log in.";
  const { disableSignup, disableSSO } = config;

  if (context.isAuthenticated) {
    // BIG: default landing is the home dashboard
    return redirect("/home");
  }

  return data(
    payload({
      title,
      subHeading,
      disableSignup,
      disableSSO,
      neonLoginEnabled: isNeonOAuthConfigured(),
      googleLoginEnabled: ENABLE_GOOGLE_LOGIN,
      microsoftLoginEnabled: ENABLE_MICROSOFT_LOGIN,
    })
  );
}

const LoginFormSchema = z.object({
  email: z
    .string()
    .transform((email) => email.toLowerCase())
    .refine(validEmail, () => ({
      message: "Please enter a valid email",
    })),
  password: z.string().min(8, "Password is too short. Minimum 8 characters."),
  redirectTo: z.string().optional(),
});

export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (method) {
      case "POST": {
        // Guard against bots sending non-form content types
        const contentType = request.headers.get("content-type") || "";
        if (
          !contentType.includes("application/x-www-form-urlencoded") &&
          !contentType.includes("multipart/form-data")
        ) {
          return data(
            error(
              new ShelfError({
                cause: null,
                message: "Invalid request",
                label: "Request validation",
                shouldBeCaptured: false,
                status: 400,
              }),
              false
            ),
            { status: 400 }
          );
        }

        let formData: FormData;
        try {
          formData = await request.formData();
        } catch (cause) {
          return data(
            error(
              new ShelfError({
                cause,
                message: "Invalid request body",
                label: "Request validation",
                shouldBeCaptured: false,
                status: 400,
              }),
              false
            ),
            { status: 400 }
          );
        }

        const { email, password, redirectTo } = parseData(
          formData,
          LoginFormSchema,
          { shouldBeCaptured: false }
        );

        const authSession = await signInWithEmail(email, password);

        if (!authSession) {
          return redirect(`/otp?email=${encodeURIComponent(email)}&mode=login`);
        }
        const { userId } = authSession;

        /**
         * The only reason we need to do this is because of the initial login
         * Theoretically, the user should always have a selected organization cookie as soon as they login for the first time
         * However we do this check to make sure they are still part of that organization
         */
        const { organizationId } = await getSelectedOrganization({
          userId,
          request,
        });

        // Set the auth session and redirect to the home dashboard
        context.setSession(authSession);

        // BIG: default landing is the home dashboard (deep-links preserved)
        return redirect(safeRedirect(redirectTo || "/home"), {
          headers: [
            setCookie(await setSelectedOrganizationIdCookie(organizationId)),
          ],
        });
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(
      cause,
      undefined,
      isLikeShelfError(cause)
        ? cause.shouldBeCaptured
        : !isZodValidationError(cause)
    );
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export default function IndexLoginForm() {
  const {
    disableSignup,
    disableSSO,
    neonLoginEnabled,
    googleLoginEnabled,
    microsoftLoginEnabled,
  } = useLoaderData<typeof loader>();
  const zo = useZorm("NewQuestionWizardScreen", LoginFormSchema);
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? undefined;
  const acceptedInvite = searchParams.get("acceptedInvite");
  const passwordReset = searchParams.get("password_reset");
  const data = useActionData<typeof action>();

  const navigation = useNavigation();
  const disabled = isFormProcessing(navigation.state);

  /** Focus the email field on mount (intentional first-field focus on auth pages). */
  const emailInputRef = useAutoFocus<HTMLInputElement>();

  /** Whether any one-click sign-in (Google / Microsoft / Neon) is available. */
  const hasQuickSignIn =
    googleLoginEnabled || microsoftLoginEnabled || neonLoginEnabled;

  return (
    <div className="w-full max-w-md">
      {acceptedInvite ? (
        <div className="mb-6 rounded-lg border border-success-200 bg-success-50 p-3 text-center text-sm text-success-700">
          Invite accepted — log in below to open your new workspace.
        </div>
      ) : null}
      {passwordReset ? (
        <div className="mb-6 rounded-lg border border-success-200 bg-success-50 p-3 text-center text-sm text-success-700">
          Password reset — log in with your new password.
        </div>
      ) : null}

      {/* Primary: one-click sign-in (social + Neon members) */}
      {hasQuickSignIn ? (
        <div className="flex flex-col gap-2.5">
          <SocialLoginButtons
            google={googleLoginEnabled}
            microsoft={microsoftLoginEnabled}
          />
          {neonLoginEnabled ? (
            <Button variant="secondary" width="full" to="/neon-login">
              Continue with Neon
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Divider before the email/password fallback */}
      {hasQuickSignIn ? (
        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-gray-200" />
          <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
            or with email
          </span>
          <span className="h-px flex-1 bg-gray-200" />
        </div>
      ) : null}

      {/* Secondary: email + password */}
      <Form ref={zo.ref} method="post" replace className="flex flex-col gap-3">
        <Input
          ref={emailInputRef}
          data-test-id="email"
          label="Email"
          placeholder="you@brooklineinteractive.org"
          required
          name={zo.fields.email()}
          type="email"
          autoComplete="username"
          disabled={disabled}
          inputClassName="w-full"
          error={zo.errors.email()?.message || data?.error.message}
        />
        <PasswordInput
          label="Password"
          placeholder="**********"
          data-test-id="password"
          name={zo.fields.password()}
          autoComplete="current-password"
          disabled={disabled}
          inputClassName="w-full"
          error={zo.errors.password()?.message || data?.error.message}
        />
        <input type="hidden" name={zo.fields.redirectTo()} value={redirectTo} />
        <Button
          type="submit"
          data-test-id="login"
          width="full"
          disabled={disabled}
        >
          Log in
        </Button>
      </Form>

      {/* Secondary links: reset password + SSO */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-gray-500">
        <Button
          variant="link"
          to={{ pathname: "/forgot-password", search: searchParams.toString() }}
        >
          Forgot password?
        </Button>
        {!disableSSO ? (
          <>
            <span className="text-gray-300">·</span>
            <Button variant="link" to="/sso-login">
              Log in with SSO
            </Button>
          </>
        ) : null}
      </div>

      {/* Sign up — a prominent action, not a buried link */}
      {disableSignup ? null : (
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <p className="mb-3 text-sm text-gray-600">New to BIG Shelf?</p>
          <Button
            variant="secondary"
            width="full"
            data-test-id="signupButton"
            to={{ pathname: "/join", search: searchParams.toString() }}
          >
            Create an account
          </Button>
        </div>
      )}
    </div>
  );
}
