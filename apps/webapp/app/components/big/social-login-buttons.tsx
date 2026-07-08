/**
 * BIG Social Login buttons (Google / Microsoft)
 *
 * Rendered on the login + join pages when the corresponding env flag is on
 * (`ENABLE_GOOGLE_LOGIN` / `ENABLE_MICROSOFT_LOGIN`, surfaced via each route's
 * loader). Each button links to the server-side initiate route, which redirects
 * to the provider. Renders nothing when neither provider is enabled.
 *
 * Brand marks are inline SVG (no external requests, CSP-safe).
 *
 * @see {@link file://./../../routes/_auth+/oauth.social.$provider.tsx}
 */
import { Button } from "~/components/shared/button";

/** Google's four-color "G" mark. */
function GoogleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.44 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

/** Microsoft's four-square mark. */
function MicrosoftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className="shrink-0"
    >
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M13 1h10v10H13z" />
      <path fill="#00A4EF" d="M1 13h10v10H1z" />
      <path fill="#FFB900" d="M13 13h10v10H13z" />
    </svg>
  );
}

/** Props: whether each provider is enabled for this site. */
type SocialLoginButtonsProps = {
  google: boolean;
  microsoft: boolean;
};

/**
 * Full-width "Continue with Google/Microsoft" buttons, each with its brand logo.
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
    <div className="flex flex-col gap-2.5">
      {google ? (
        <Button variant="secondary" width="full" to="/oauth/social/google">
          <span className="flex items-center justify-center gap-2.5 font-medium">
            <GoogleIcon />
            Continue with Google
          </span>
        </Button>
      ) : null}
      {microsoft ? (
        <Button variant="secondary" width="full" to="/oauth/social/microsoft">
          <span className="flex items-center justify-center gap-2.5 font-medium">
            <MicrosoftIcon />
            Continue with Microsoft
          </span>
        </Button>
      ) : null}
    </div>
  );
}
