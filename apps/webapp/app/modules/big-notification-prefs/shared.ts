/**
 * BIG per-user booking-email preferences — client-safe types
 *
 * Route COMPONENTS and form components import from here, never from
 * `service.server.ts` — that file pulls in Prisma, and importing it from a
 * component drags the DB client into the browser bundle (Vite rejects the build).
 * Same split as `big-kiosk-content/shared.ts` and `big-neon-auth/shared.ts`.
 *
 * @see {@link file://./service.server.ts} — the server module
 */
import { z } from "zod";

/**
 * Which booking emails a person receives about OTHER PEOPLE's bookings.
 *
 * Both default to `true`, so anyone who never opens the settings keeps getting
 * exactly what they get today. There is no row in the database until someone
 * actually changes something.
 */
export type NotificationPreferences = {
  /** Email me when someone else's booking is reserved. */
  notifyOnReservation: boolean;
  /** Email me when someone else's booking goes overdue. */
  notifyOnOverdue: boolean;
};

/** Absent row = receive everything. Keeps existing behaviour for everyone. */
export const NOTIFICATION_PREFERENCE_DEFAULTS: NotificationPreferences = {
  notifyOnReservation: true,
  notifyOnOverdue: true,
};

/**
 * Form payload for the preferences form.
 *
 * An unchecked Switch/checkbox submits NOTHING, so a missing key means "off" —
 * hence `.default("false")` rather than a required boolean. Getting this wrong
 * would make it impossible to ever turn a toggle back off.
 */
export const NotificationPreferencesSchema = z.object({
  notifyOnReservation: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "on"),
  notifyOnOverdue: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "on"),
});

/** The intent both settings forms post under. */
export const UPDATE_NOTIFICATION_PREFERENCES_INTENT =
  "updateNotificationPreferences" as const;
