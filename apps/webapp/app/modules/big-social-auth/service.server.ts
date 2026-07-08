/**
 * BIG Social Login (Google / Microsoft) — server service
 *
 * Lets users sign in OR sign up with Google or Microsoft via Supabase OAuth. An
 * existing account signs in; a brand-new social identity is provisioned a Shelf
 * user + personal workspace (see the callback route). An email that already
 * belongs to a different account is rejected, so social login can't hijack a
 * password account.
 *
 * Gated behind env flags (`ENABLE_GOOGLE_LOGIN` / `ENABLE_MICROSOFT_LOGIN`) so
 * the buttons stay hidden until the provider is also enabled in the Supabase
 * dashboard. Initiation mirrors the SAML SSO flow (`signInWithSSO`): call
 * Supabase server-side, get a URL, redirect the browser to it; the provider then
 * redirects back to the callback with tokens in the URL fragment.
 *
 * @see {@link file://./../../routes/_auth+/oauth.social.$provider.tsx} — initiate
 * @see {@link file://./../../routes/_auth+/oauth.social-callback.tsx} — callback
 */
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  ENABLE_GOOGLE_LOGIN,
  ENABLE_MICROSOFT_LOGIN,
  SERVER_URL,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";

const label = "Social Auth" as const;

/** Where Supabase redirects back to after the provider consents. */
export const SOCIAL_CALLBACK_PATH = "/oauth/social-callback";

/**
 * Supported social providers, mapped to their Supabase provider id. Note
 * Microsoft is Supabase's `azure` provider.
 */
export const SOCIAL_PROVIDERS = {
  // Google returns email/profile by default; Azure needs `email` requested explicitly.
  google: { supabaseProvider: "google", label: "Google", scopes: undefined },
  microsoft: { supabaseProvider: "azure", label: "Microsoft", scopes: "email" },
} as const;

/** A supported social provider key (`"google" | "microsoft"`). */
export type SocialProvider = keyof typeof SOCIAL_PROVIDERS;

/** True when the given provider is enabled via its env flag. */
export function isSocialProviderEnabled(provider: SocialProvider): boolean {
  if (provider === "google") {
    return ENABLE_GOOGLE_LOGIN;
  }
  if (provider === "microsoft") {
    return ENABLE_MICROSOFT_LOGIN;
  }
  return false;
}

/**
 * Builds the provider authorize URL to redirect the user to. Server-side, like
 * `signInWithSSO`: Supabase returns the URL and the route redirects to it.
 * Uses the implicit flow (shelf's client sets no `flowType`), so tokens come
 * back in the callback URL fragment.
 *
 * @param provider - The social provider to sign in with
 * @returns The absolute provider authorize URL
 * @throws {ShelfError} If the provider is disabled or Supabase can't build the URL
 */
export async function buildSocialSignInUrl(
  provider: SocialProvider
): Promise<string> {
  if (!isSocialProviderEnabled(provider)) {
    throw new ShelfError({
      cause: null,
      title: "Login method unavailable",
      message: `Logging in with ${
        SOCIAL_PROVIDERS[provider]?.label ?? provider
      } isn't enabled for this site.`,
      label,
      status: 404,
      shouldBeCaptured: false,
    });
  }

  const { supabaseProvider, scopes } = SOCIAL_PROVIDERS[provider];
  const { data, error } = await getSupabaseAdmin().auth.signInWithOAuth({
    provider: supabaseProvider,
    options: {
      redirectTo: `${SERVER_URL}${SOCIAL_CALLBACK_PATH}`,
      // Return the URL instead of attempting a browser redirect (we're server-side).
      skipBrowserRedirect: true,
      scopes,
    },
  });

  if (error || !data?.url) {
    throw new ShelfError({
      cause: error,
      message:
        "Could not start the social login. The provider may not be enabled in Supabase.",
      label,
      shouldBeCaptured: false,
    });
  }

  return data.url;
}
