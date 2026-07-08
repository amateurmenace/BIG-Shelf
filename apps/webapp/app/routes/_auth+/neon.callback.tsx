/**
 * "Log in with Neon" — callback (`/neon/callback`)
 *
 * Neon redirects the member back here with `?code&state`. We (server-side):
 *  1. Verify the signed CSRF `state`.
 *  2. Exchange the `code` for the member's Neon Account ID.
 *  3. Resolve their profile + confirm an ACTIVE membership.
 *  4. Provision/link the shelf member and mint an app session.
 *  5. Set the session + selected-org cookie and land them on `/reserve`.
 *
 * Public route (added to the `protect` allowlist in `server/index.ts`).
 *
 * @see {@link file://./neon-login.tsx}
 * @see {@link file://./../../modules/big-neon-auth/service.server.ts}
 */
import type { LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import {
  exchangeNeonAuthCodeForAccountId,
  isNeonOAuthConfigured,
  resolveNeonMemberByAccountId,
} from "~/integrations/neon-crm/client.server";
import {
  provisionAndMintNeonSession,
  verifyNeonOAuthState,
} from "~/modules/big-neon-auth/service.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie } from "~/utils/cookies.server";
import { SERVER_URL } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  try {
    if (!isNeonOAuthConfigured()) {
      throw new ShelfError({
        cause: null,
        title: "Neon login isn't available yet",
        message:
          "Signing in with Neon hasn't been configured for this site yet.",
        label: "Neon Auth",
        status: 503,
        shouldBeCaptured: false,
      });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // CSRF: only accept a callback we started.
    if (!verifyNeonOAuthState(state)) {
      throw new ShelfError({
        cause: null,
        message:
          "Your Neon sign-in link has expired or is invalid. Please try again.",
        label: "Neon Auth",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    if (!code) {
      throw new ShelfError({
        cause: null,
        message: "Neon didn't return an authorization code. Please try again.",
        label: "Neon Auth",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const neonAccountId = await exchangeNeonAuthCodeForAccountId({
      code,
      redirectUri: `${SERVER_URL}/neon/callback`,
    });

    const neonMember = await resolveNeonMemberByAccountId(neonAccountId);

    const { authSession, organizationId } =
      await provisionAndMintNeonSession(neonMember);

    context.setSession(authSession);

    return redirect("/reserve", {
      headers: [
        setCookie(await setSelectedOrganizationIdCookie(organizationId)),
      ],
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export const meta = () => [
  { title: appendToMetaTitle("Signing in with Neon") },
];

export default function NeonCallback() {
  // Loader always redirects or throws to the _auth ErrorBoundary.
  return null;
}
