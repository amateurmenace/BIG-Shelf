/**
 * Social login — callback (`/oauth/social-callback`)
 *
 * Where Supabase redirects after Google/Microsoft consent. The tokens arrive in
 * the URL fragment (not server-readable), so — like the SSO callback — a tiny
 * client effect reads the Supabase session via `onAuthStateChange` and forwards
 * the refresh token (+ the provider's name) to this route's action. The server
 * re-derives a trusted session, then signs in an existing user or provisions a
 * brand-new one (with a personal workspace). An email that already belongs to a
 * different account is rejected (log in with that method instead).
 *
 * Public route (added to the `protect` allowlist in `server/index.ts`).
 *
 * @see {@link file://./../../modules/big-social-auth/service.server.ts}
 * @see {@link file://./oauth.callback.tsx} — the SSO equivalent this mirrors
 */
import { useEffect } from "react";
import { OrganizationRoles } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, useFetcher } from "react-router";
import { z } from "zod";
import { Button } from "~/components/shared/button";
import { Spinner } from "~/components/shared/spinner";
import { db } from "~/database/db.server";
import { useSearchParams } from "~/hooks/search-params";
import { supabaseClient } from "~/integrations/supabase/client";
import { refreshAccessToken } from "~/modules/auth/service.server";
import {
  assertActiveNeonMemberForSignup,
  linkNeonAccountByEmail,
} from "~/modules/big-neon-auth/service.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { createUser } from "~/modules/user/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie } from "~/utils/cookies.server";
import { NEON_MEMBER_ORG_ID } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error, parseData, safeRedirect } from "~/utils/http.server";
import { randomUsernameFromEmail } from "~/utils/user";

const label = "Social Auth" as const;

const SocialCallbackSchema = z.object({
  refreshToken: z.string().min(1),
  redirectTo: z.string().optional(),
  // From the provider profile (user_metadata) — used to provision a new user.
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const { refreshToken, redirectTo, firstName, lastName } = parseData(
      await request.formData(),
      SocialCallbackSchema
    );

    // Never trust the client — re-derive a session from the refresh token.
    const authSession = await refreshAccessToken(refreshToken);

    // The id + email come from the trusted, server-derived session (not input).
    const existingById = await db.user.findFirst({
      where: { id: authSession.userId },
      select: { id: true },
    });

    if (!existingById) {
      // First time we've seen this social identity. If the email already belongs
      // to another account (e.g. an unlinked email/password user), don't hijack
      // it — send them to their existing method.
      const existingByEmail = await db.user.findFirst({
        where: { email: authSession.email },
        select: { id: true },
      });
      if (existingByEmail) {
        throw new ShelfError({
          cause: null,
          title: "Account already exists",
          message:
            "An account already exists for this email. Please log in with your email and password (or the method you used before).",
          label,
          status: 409,
          shouldBeCaptured: false,
        });
      }

      // BIG: cross-reference the social email against Neon. Active members are
      // provisioned straight into the member workspace as MEMBER; a non-member
      // gets the membership message (thrown → shown below) and NO account is
      // created — their social token simply expires. Returns null only when Neon
      // is unconfigured (local dev), where we keep the original personal-workspace
      // behavior so social login still works.
      const neonMember = await assertActiveNeonMemberForSignup(
        authSession.email
      );

      if (neonMember) {
        if (!NEON_MEMBER_ORG_ID) {
          throw new ShelfError({
            cause: null,
            title: "Member workspace not configured",
            message:
              "Your membership is active, but the member workspace isn't set up yet (NEON_MEMBER_ORG_ID). Please contact us.",
            label,
            status: 503,
          });
        }
        // The Supabase auth account already exists from the OAuth flow, so
        // createUser only writes the shelf-side records + the MEMBER membership
        // in BIG's workspace (isSSO → no password, onboarded).
        await createUser({
          email: authSession.email,
          userId: authSession.userId,
          username: randomUsernameFromEmail(authSession.email),
          firstName: firstName || neonMember.firstName || undefined,
          lastName: lastName || neonMember.lastName || undefined,
          isSSO: true,
          organizationId: NEON_MEMBER_ORG_ID,
          roles: [OrganizationRoles.MEMBER],
        });
        // Best-effort: stamp their Neon account id for future reconciliation.
        await linkNeonAccountByEmail(authSession.email);

        context.setSession(authSession);
        // Land them in the member workspace and on the reserve hub.
        return redirect(safeRedirect("/reserve"), {
          headers: [
            setCookie(
              await setSelectedOrganizationIdCookie(NEON_MEMBER_ORG_ID)
            ),
          ],
        });
      }

      // Neon unconfigured (dev) → original behavior: a personal workspace so
      // social login still works locally.
      await createUser({
        email: authSession.email,
        userId: authSession.userId,
        username: randomUsernameFromEmail(authSession.email),
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        isSSO: true,
      });
    }

    context.setSession(authSession);
    // BIG: default landing is the home dashboard (deep-links preserved).
    return redirect(safeRedirect(redirectTo || "/home"));
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export function loader({ context }: LoaderFunctionArgs) {
  if (context.isAuthenticated) {
    // BIG: default landing is the home dashboard
    return redirect("/home");
  }
  return data(
    payload({
      title: "Signing you in",
      subHeading: "Please wait while we connect your account",
    })
  );
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export default function SocialCallback() {
  const fetcher = useFetcher<typeof action>();
  const { data: fetcherData } = fetcher;
  const [searchParams] = useSearchParams();
  // BIG: default landing is the home dashboard
  const redirectTo = searchParams.get("redirectTo") ?? "/home";

  useEffect(() => {
    const {
      data: { subscription },
    } = supabaseClient.auth.onAuthStateChange((event, supabaseSession) => {
      if (event === "SIGNED_IN") {
        // The fragment (#access_token=…&refresh_token=…) isn't server-readable;
        // forward the refresh token (the server re-derives the session) plus the
        // provider's name so a first-time user can be provisioned.
        const refreshToken = supabaseSession?.refresh_token;
        if (!refreshToken) {
          return;
        }
        const meta = supabaseSession?.user?.user_metadata ?? {};
        const fullName = String(meta.full_name || meta.name || "").trim();
        const firstName = String(
          meta.given_name || meta.first_name || fullName.split(" ")[0] || ""
        ).trim();
        const lastName = String(
          meta.family_name ||
            meta.last_name ||
            fullName.split(" ").slice(1).join(" ") ||
            ""
        ).trim();

        const formData = new FormData();
        formData.append("refreshToken", refreshToken);
        formData.append("redirectTo", redirectTo);
        formData.append("firstName", firstName);
        formData.append("lastName", lastName);
        void fetcher.submit(formData, { method: "post" });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetcher, redirectTo]);

  return (
    <div className="flex justify-center text-center">
      {fetcherData?.error ? (
        <div className="mx-auto max-w-md text-left">
          <h2 className="mb-2 text-center text-lg font-semibold text-gray-900">
            {fetcherData.error.title || "Something went wrong"}
          </h2>
          <p className="text-sm text-gray-600">{fetcherData.error.message}</p>
          {fetcherData.error.title === "Active membership required" ? (
            <div className="mt-4 flex flex-col gap-2 text-center text-sm">
              <a
                href="https://brooklineinteractive.app.neoncrm.com/forms/membership"
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary-600 underline"
              >
                Sign up for a BIG Membership →
              </a>
              <a
                href="mailto:jessica@brooklineinteractive.org"
                className="text-gray-600 underline"
              >
                Email jessica@brooklineinteractive.org
              </a>
            </div>
          ) : null}
          <div className="mt-4 text-center">
            <Button to="/" variant="secondary">
              Back to login
            </Button>
          </div>
        </div>
      ) : (
        <Spinner />
      )}
    </div>
  );
}
