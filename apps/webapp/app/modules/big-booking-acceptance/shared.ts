/**
 * Booking acceptance — client-safe constants and schemas
 *
 * Route components import from HERE, never from `service.server.ts` — pulling a
 * `.server` module into the client bundle makes vite reject the build.
 *
 * @see {@link file://./service.server.ts}
 */
import { z } from "zod";

/** Form intents handled by the accept/decline action on the booking page. */
export const BOOKING_ACCEPTANCE_INTENT = {
  accept: "acceptBooking",
  decline: "declineBooking",
} as const;

/** Max length of the note someone may leave when declining. */
export const DECLINE_NOTE_MAX_LENGTH = 500;

/** Payload for the decline action. */
export const DeclineBookingSchema = z.object({
  responseNote: z
    .string()
    .max(
      DECLINE_NOTE_MAX_LENGTH,
      `Please keep your note under ${DECLINE_NOTE_MAX_LENGTH} characters.`
    )
    .optional(),
});

/**
 * Who a booking is being made for.
 *
 * Replaces the bare "Custodian" picker: staff pick "Myself" (the common case,
 * and the default) or "Someone else", which reveals the member picker.
 */
export const RESERVED_FOR = {
  myself: "myself",
  someoneElse: "someoneElse",
} as const;

export type ReservedForChoice =
  (typeof RESERVED_FOR)[keyof typeof RESERVED_FOR];
