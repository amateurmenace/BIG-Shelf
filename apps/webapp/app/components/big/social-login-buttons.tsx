/**
 * BIG Social Login buttons (Google / Microsoft)
 *
 * Rendered on the login + join pages when the corresponding env flag is on
 * (`ENABLE_GOOGLE_LOGIN` / `ENABLE_MICROSOFT_LOGIN`, surfaced via each route's
 * loader). Each button links to the server-side initiate route, which redirects
 * to the provider. Renders nothing when neither provider is enabled.
 *
 * @see {@link file://./../../routes/_auth+/oauth.social.$provider.tsx}
 */
import { Button } from "~/components/shared/button";

/** Props: whether each provider is enabled for this site. */
type SocialLoginButtonsProps = {
  google: boolean;
  microsoft: boolean;
};

/**
 * Full-width "Continue with Google/Microsoft" buttons.
 *
 * @param props.google - Show the Google button
 * @param props.microsoft - Show the Microsoft button
 */
export function SocialLoginButtons({
  google,
  microsoft,
}: SocialLoginButtonsProps) {
  if (!google && !microsoft) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      {google ? (
        <Button variant="secondary" width="full" to="/oauth/social/google">
          Continue with Google
        </Button>
      ) : null}
      {microsoft ? (
        <Button variant="secondary" width="full" to="/oauth/social/microsoft">
          Continue with Microsoft
        </Button>
      ) : null}
    </div>
  );
}
