/**
 * Social login — initiate (`/oauth/social/:provider`)
 *
 * Kicks off Google/Microsoft sign-in: asks Supabase for the provider authorize
 * URL and redirects the browser to it. The provider then redirects back to
 * `/oauth/social-callback` with tokens in the URL fragment.
 *
 * Public route (added to the `protect` allowlist in `server/index.ts`).
 *
 * @see {@link file://./oauth.social-callback.tsx}
 * @see {@link file://./../../modules/big-social-auth/service.server.ts}
 */
import type { LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { z } from "zod";
import {
  buildSocialSignInUrl,
  type SocialProvider,
} from "~/modules/big-social-auth/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, getParams } from "~/utils/http.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const { provider } = getParams(
    params,
    z.object({ provider: z.enum(["google", "microsoft"]) })
  );

  try {
    const url = await buildSocialSignInUrl(provider as SocialProvider);
    throw redirect(url);
  } catch (cause) {
    // A redirect is a Response — let it through.
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export const meta = () => [{ title: appendToMetaTitle("Signing you in") }];

export default function SocialLoginInitiate() {
  // The loader always redirects or throws; nothing to render.
  return null;
}
