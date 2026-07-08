/**
 * "Log in with Neon" — initiate (`/neon-login`)
 *
 * Kicks off Neon's constituent OAuth: issues a signed CSRF `state`, builds the
 * per-org authorize URL, and redirects the member to Neon to sign in. Neon then
 * redirects back to `/neon/callback` (see `neon.callback.tsx`).
 *
 * Public route (added to the `protect` allowlist in `server/index.ts`).
 *
 * @see {@link file://./neon.callback.tsx}
 * @see {@link file://./../../integrations/neon-crm/client.server.ts}
 */
import type { LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import {
  buildNeonAuthorizeUrl,
  isNeonOAuthConfigured,
} from "~/integrations/neon-crm/client.server";
import { createNeonOAuthState } from "~/modules/big-neon-auth/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { SERVER_URL } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";

export function loader({ context }: LoaderFunctionArgs) {
  try {
    // Already signed in → send them into the app.
    if (context.isAuthenticated) {
      throw redirect("/reserve");
    }

    if (!isNeonOAuthConfigured()) {
      throw new ShelfError({
        cause: null,
        title: "Neon login isn't available yet",
        message:
          "Signing in with Neon hasn't been configured for this site yet. Please use your email and password, or contact us.",
        label: "Neon Auth",
        status: 503,
        shouldBeCaptured: false,
      });
    }

    const state = createNeonOAuthState();
    const authorizeUrl = buildNeonAuthorizeUrl({
      redirectUri: `${SERVER_URL}/neon/callback`,
      state,
    });

    throw redirect(authorizeUrl);
  } catch (cause) {
    // Redirects (authed → /reserve, or → Neon) are Responses — let them through.
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export const meta = () => [{ title: appendToMetaTitle("Log in with Neon") }];

export default function NeonLogin() {
  // The loader always redirects or throws; nothing to render.
  return null;
}
