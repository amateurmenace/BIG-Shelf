/**
 * "A reservation was made for you" email
 *
 * Sent when a staff member reserves equipment or a room on someone else's
 * behalf. The booking is already held in the recipient's name — this email
 * tells them it exists and asks them to confirm or decline it.
 *
 * @see {@link file://./../../modules/big-booking-acceptance/service.server.ts}
 */
import {
  Button,
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

/** Everything the template needs, already formatted for display. */
export interface BookingAcceptanceRequestProps {
  /** Recipient's first/display name, for the greeting. */
  firstName?: string | null;
  /** Recipient's email address. */
  email: string;
  /** The booking's name. */
  bookingName: string;
  /** The booking's id — used to build the deep link. */
  bookingId: string;
  /** Pre-formatted booking period, e.g. "5 May 2026, 09:00 - 17:00". */
  period: string;
  /** Display name of the staff member who made the reservation. */
  reservedBy: string;
  /** How many assets are on the booking. */
  assetCount: number;
  /** Names of any rooms on the booking. */
  roomNames: string[];
  /** Workspace name, for context when someone belongs to several. */
  organizationName: string;
}

/** Builds the URL the recipient lands on to accept or decline. */
function bookingUrl(bookingId: string) {
  return `${SERVER_URL}/bookings/${bookingId}`;
}

/** One-line summary of what is on the booking. */
function contentsLine({
  assetCount,
  roomNames,
}: Pick<BookingAcceptanceRequestProps, "assetCount" | "roomNames">) {
  const parts: string[] = [];
  if (assetCount > 0) {
    parts.push(`${assetCount} item${assetCount === 1 ? "" : "s"} of equipment`);
  }
  if (roomNames.length > 0) {
    parts.push(roomNames.join(", "));
  }
  return parts.length > 0 ? parts.join(" + ") : "No items yet";
}

/** Plain-text half of the email. */
export const bookingAcceptanceRequestText = (
  props: BookingAcceptanceRequestProps
) => `Hey${props.firstName ? ` ${props.firstName}` : ""},

${props.reservedBy} has reserved the following for you at ${
  props.organizationName
}:

Reservation: ${props.bookingName}
When: ${props.period}
What: ${contentsLine(props)}

The equipment is already being held for you. Please confirm you want it - or
decline if this was not what you expected - here:

${bookingUrl(props.bookingId)}

If you have any questions, reply to this email or contact us at ${SUPPORT_EMAIL}.

The Shelf Team
`;

/** React Email template. */
function BookingAcceptanceRequestTemplate(
  props: BookingAcceptanceRequestProps
) {
  const { emailPrimaryColor } = config;

  return (
    <Html>
      <Head>
        <title>A reservation was made for you</title>
      </Head>

      <Container style={{ padding: "32px 16px", maxWidth: "100%" }}>
        <LogoForEmail />

        <div style={{ paddingTop: "8px" }}>
          <Text style={{ ...styles.p }}>
            Hey{props.firstName ? ` ${props.firstName}` : ""},
          </Text>

          <Text style={{ ...styles.p }}>
            <strong>{props.reservedBy}</strong> has reserved the following for
            you at <strong>{props.organizationName}</strong>.
          </Text>

          <Text style={{ ...styles.h2 }}>{props.bookingName}</Text>

          <Text style={{ ...styles.p, marginTop: 0 }}>
            <strong>When:</strong> {props.period}
            <br />
            <strong>What:</strong> {contentsLine(props)}
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
            The equipment is already being held for you, so nothing is lost if
            you reply later. Confirming just lets us know you are expecting it.
          </Text>

          <Button
            href={bookingUrl(props.bookingId)}
            style={{
              ...styles.button,
              textAlign: "center" as const,
              maxWidth: "260px",
              marginBottom: "24px",
            }}
          >
            Review &amp; confirm reservation
          </Button>

          <Text style={{ ...styles.p }}>
            If this is not what you expected, open the same link and decline —
            it lets the team know to release the equipment.
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
export const bookingAcceptanceRequestHtml = (
  props: BookingAcceptanceRequestProps
) => render(<BookingAcceptanceRequestTemplate {...props} />);

/**
 * Sends the "a reservation was made for you" email.
 *
 * Never throws — a failed notification must not roll back a reservation that
 * has already been made and is already holding equipment.
 *
 * @param props - Recipient and booking details, pre-formatted for display.
 */
export async function sendBookingAcceptanceRequestEmail(
  props: BookingAcceptanceRequestProps
) {
  try {
    const html = await bookingAcceptanceRequestHtml(props);
    const text = bookingAcceptanceRequestText(props);

    void sendEmail({
      to: props.email,
      subject: `Please confirm: ${props.bookingName}`,
      html,
      text,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Something went wrong while sending the booking acceptance request email",
        additionalData: { email: props.email, bookingId: props.bookingId },
        label: "Booking",
      })
    );
  }
}
