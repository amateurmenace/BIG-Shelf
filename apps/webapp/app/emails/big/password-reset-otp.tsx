/**
 * Password-reset code email
 *
 * BIG: this email used to be sent by Supabase itself
 * (`auth.resetPasswordForEmail`), which means it went out over Supabase's own
 * SMTP configuration rather than the workspace's. When that is not configured,
 * Supabase falls back to its built-in sender, which is heavily rate-limited and
 * in many projects only delivers to project members — so ordinary members asked
 * for a reset and simply never received anything, with no error anywhere.
 *
 * The code is now generated without sending (`auth.admin.generateLink`) and
 * delivered here, over the same SMTP transport that already sends invites and
 * booking notifications.
 *
 * @see {@link file://./../../modules/auth/service.server.ts} — sendPasswordResetOtp
 * @see {@link file://./../../routes/_auth+/forgot-password.tsx}
 */
import {
  Container,
  Head,
  Html,
  Link,
  render,
  Text,
} from "@react-email/components";
import { config } from "~/config/shelf.config";
import { SERVER_URL, SUPPORT_EMAIL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { LogoForEmail } from "../logo";
import { sendEmail } from "../mail.server";
import { styles } from "../styles";

/** Props for the password-reset email. */
export interface PasswordResetOtpProps {
  /** Recipient's first/display name, for the greeting. */
  firstName?: string | null;
  /** Where to send it. */
  email: string;
  /** The one-time code the recipient types into the reset form. */
  otp: string;
  /**
   * When true, the reset was started by a workspace admin on the user's
   * behalf rather than by the user themselves — worth saying so, otherwise an
   * unexpected code looks like an attack.
   */
  initiatedByAdmin?: boolean;
  /** Name of the admin who started it, when `initiatedByAdmin`. */
  adminName?: string | null;
}

/** Plain-text half of the email. */
export const passwordResetOtpText = ({
  firstName,
  otp,
  initiatedByAdmin,
  adminName,
}: PasswordResetOtpProps) => `Hey${firstName ? ` ${firstName}` : ""},

${
  initiatedByAdmin
    ? `${
        adminName || "A workspace administrator"
      } started a password reset for your account.`
    : "You asked to reset your password."
}

Your one-time code is: ${otp}

Enter it here, along with your new password:
${SERVER_URL}/forgot-password

The code expires in one hour and can only be used once. If you were not
expecting this, you can ignore this email - your password will not change.

Questions? Contact us at ${SUPPORT_EMAIL}.

The Shelf Team
`;

/** React Email template. */
function PasswordResetOtpTemplate({
  firstName,
  otp,
  initiatedByAdmin,
  adminName,
}: PasswordResetOtpProps) {
  const { emailPrimaryColor } = config;

  return (
    <Html>
      <Head>
        <title>Your password reset code</title>
      </Head>

      <Container style={{ padding: "32px 16px", maxWidth: "100%" }}>
        <LogoForEmail />

        <div style={{ paddingTop: "8px" }}>
          <Text style={{ ...styles.p }}>
            Hey{firstName ? ` ${firstName}` : ""},
          </Text>

          <Text style={{ ...styles.p }}>
            {initiatedByAdmin
              ? `${
                  adminName || "A workspace administrator"
                } started a password reset for your account.`
              : "You asked to reset your password."}
          </Text>

          <Text style={{ ...styles.h2 }}>Your one-time code</Text>

          {/* Large, spaced and selectable — this is the one thing the reader
              has to copy accurately. */}
          <Text
            style={{
              fontSize: "32px",
              fontWeight: 700,
              letterSpacing: "8px",
              color: "#101828",
              backgroundColor: "#F9FAFB",
              border: "1px solid #EAECF0",
              borderRadius: "8px",
              padding: "16px",
              textAlign: "center" as const,
              margin: "0 0 24px",
            }}
          >
            {otp}
          </Text>

          <Text style={{ ...styles.p }}>
            Enter it at{" "}
            <Link
              href={`${SERVER_URL}/forgot-password`}
              style={{ color: emailPrimaryColor }}
            >
              {SERVER_URL}/forgot-password
            </Link>{" "}
            along with your new password.
          </Text>

          <Text
            style={{
              ...styles.p,
              backgroundColor: "#FFF8E1",
              border: "1px solid #FFE082",
              borderRadius: "8px",
              padding: "16px",
            }}
          >
            The code expires in one hour and can only be used once. If you were
            not expecting this email you can ignore it — your password will not
            change.
          </Text>

          <Text style={{ ...styles.p }}>
            Questions? Reach us at{" "}
            <Link
              href={`mailto:${SUPPORT_EMAIL}`}
              style={{ color: emailPrimaryColor }}
            >
              {SUPPORT_EMAIL}
            </Link>
            .
          </Text>

          <Text style={{ ...styles.p }}>The Shelf Team</Text>
        </div>
      </Container>
    </Html>
  );
}

/** Renders the HTML half of the email. */
export const passwordResetOtpHtml = (props: PasswordResetOtpProps) =>
  render(<PasswordResetOtpTemplate {...props} />);

/**
 * Sends the password-reset code.
 *
 * @param props - Recipient and the one-time code.
 * @throws {ShelfError} When rendering or queueing the email fails — the caller
 *   surfaces this, because a reset the user never receives is worse than an
 *   error they can act on.
 */
export async function sendPasswordResetOtpEmail(props: PasswordResetOtpProps) {
  try {
    const html = await passwordResetOtpHtml(props);
    const text = passwordResetOtpText(props);

    void sendEmail({
      to: props.email,
      subject: `Your password reset code: ${props.otp}`,
      html,
      text,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "We couldn't send your reset code. Please try again in a moment, or contact support.",
      additionalData: { email: props.email },
      label: "Auth",
    });
  }
}
