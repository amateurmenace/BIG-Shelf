/**
 * BIG per-user booking-email preferences — server service
 *
 * Owns `UserBookingNotificationPreference`: which booking emails a person receives
 * ABOUT OTHER PEOPLE'S BOOKINGS, per workspace.
 *
 * ## Why this exists
 *
 * Shelf's notification settings are org-level and all-or-nothing:
 * `notifyAdminsOnNewBooking` mails EVERY admin on EVERY reservation, and the only
 * way to stop mailing one person was to stop mailing all of them. Staff ended up
 * with an inbox full of reservation mail and no way out.
 *
 * ## What it deliberately does NOT cover
 *
 * Emails about a booking someone is the custodian, creator, or named recipient of.
 * Those are about their own responsibilities — nobody should be able to mute the
 * overdue notice for equipment sitting in their own hands. The filter is applied
 * only to recipients resolved with reason `admin` or `always_notify`.
 *
 * ## Absent row = receive everything
 *
 * There is no backfill and no row is written until someone changes a setting, so
 * every existing user keeps today's behaviour exactly.
 *
 * @see {@link file://./../booking/notification-recipients.server.ts} — where the filter is applied
 * @see {@link file://./shared.ts} — client-safe types the settings UIs import
 */
import type { UserBookingNotificationPreference } from "@prisma/client";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import type { NotificationPreferences } from "./shared";
import { NOTIFICATION_PREFERENCE_DEFAULTS } from "./shared";

const label = "Settings" as const;

/**
 * The booking events a person can individually mute. Only events that fire for
 * OTHER people's bookings are listed — see the module doc.
 */
export type MutableNotificationEvent = "RESERVATION" | "OVERDUE";

/** Maps a mutable event to the column that governs it. */
const EVENT_COLUMN: Record<
  MutableNotificationEvent,
  keyof NotificationPreferences
> = {
  RESERVATION: "notifyOnReservation",
  OVERDUE: "notifyOnOverdue",
};

/**
 * Reads one person's preferences for a workspace.
 *
 * @param args.userId - Whose preferences
 * @param args.organizationId - Which workspace they apply to
 * @returns Their saved preferences, or the defaults (receive everything) when
 *   they've never changed anything
 * @throws {ShelfError} If the read fails
 */
export async function getNotificationPreferences({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<NotificationPreferences> {
  try {
    const row = await db.userBookingNotificationPreference.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });

    return row ? toPreferences(row) : { ...NOTIFICATION_PREFERENCE_DEFAULTS };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not load your email notification settings",
      additionalData: { userId, organizationId },
      label,
    });
  }
}

/**
 * Saves one person's preferences for a workspace (creating the row on first use).
 *
 * @param args.userId - Whose preferences to save
 * @param args.organizationId - Which workspace they apply to
 * @param args.preferences - The full preference set to persist
 * @returns The saved preferences
 * @throws {ShelfError} If the write fails
 */
export async function upsertNotificationPreferences({
  userId,
  organizationId,
  preferences,
}: {
  userId: string;
  organizationId: string;
  preferences: NotificationPreferences;
}): Promise<NotificationPreferences> {
  try {
    const row = await db.userBookingNotificationPreference.upsert({
      where: { userId_organizationId: { userId, organizationId } },
      create: { userId, organizationId, ...preferences },
      update: { ...preferences },
    });

    return toPreferences(row);
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not save the email notification settings",
      additionalData: { userId, organizationId },
      label,
    });
  }
}

/**
 * The set of user ids who have MUTED a given event in this workspace.
 *
 * One query for the whole recipient list, rather than a lookup per recipient —
 * this runs on every booking email, so it must not turn one notification into N
 * round-trips.
 *
 * Fails OPEN (returns an empty set): if we can't read preferences, people get the
 * email. An unsent notification is invisible and can hide a late return; a
 * redundant one is merely annoying.
 *
 * @param args.organizationId - The workspace the booking belongs to
 * @param args.event - Which notification is being sent
 * @returns User ids who have opted OUT of this event
 */
export async function getMutedUserIds({
  organizationId,
  event,
}: {
  organizationId: string;
  event: MutableNotificationEvent;
}): Promise<Set<string>> {
  try {
    const column = EVENT_COLUMN[event];

    const muted = await db.userBookingNotificationPreference.findMany({
      where: { organizationId, [column]: false },
      select: { userId: true },
    });

    return new Set(muted.map((row) => row.userId));
  } catch {
    // Fail open — see the doc above. Silently dropping mail is the worse failure.
    return new Set<string>();
  }
}

/** Narrows a DB row to just the preference flags. */
function toPreferences(
  row: UserBookingNotificationPreference
): NotificationPreferences {
  return {
    notifyOnReservation: row.notifyOnReservation,
    notifyOnOverdue: row.notifyOnOverdue,
  };
}
