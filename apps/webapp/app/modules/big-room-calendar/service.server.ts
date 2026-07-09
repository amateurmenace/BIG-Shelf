/**
 * BIG room calendar — server service
 *
 * Mirrors room bookings onto a shared "Room Bookings" Google Calendar so the
 * BIG team sees the studio schedule inside Google Workspace. One Google event
 * per (booking, room) pair, with a **deterministic event id** (hex of
 * `bookingId:roomId`), so every push is idempotent — create, update, and
 * revive-after-delete all funnel through the same upsert.
 *
 * Lifecycle contract:
 *  - A room event EXISTS while its booking is RESERVED / ONGOING / OVERDUE.
 *  - Cancelling, deleting, reverting to draft, or removing the room from the
 *    booking deletes the event.
 *  - Checked-in (COMPLETE) bookings keep their past events as history; the
 *    admin "Sync now" reconcile prunes any still-upcoming events whose booking
 *    no longer needs them (e.g. gear returned early).
 *
 * The push hooks in the booking service call the `void`-returning best-effort
 * functions here — they NEVER throw (a calendar hiccup must never break a
 * booking mutation) and no-op when the integration isn't configured. The
 * admin-facing `resyncRoomCalendar` DOES throw, so setup problems surface in
 * the settings UI.
 *
 * @see {@link file://./../../integrations/google-calendar/client.server.ts}
 * @see {@link file://./../booking/service.server.ts} — the lifecycle hooks
 * @see {@link file://./../../routes/_layout+/settings.room-calendar.tsx}
 */
import { BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import {
  deleteCalendarEvent,
  isGoogleCalendarConfigured,
  listUpcomingCalendarEventIds,
  upsertCalendarEvent,
  type GoogleCalendarEvent,
} from "~/integrations/google-calendar/client.server";
import { SERVER_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";

const label = "Room Calendar" as const;

/** Statuses during which a room booking should appear on the calendar. */
const ACTIVE_STATUSES: BookingStatus[] = [
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/** Google's 11 fixed event colors (colorId → hex), for nearest-color mapping. */
const GOOGLE_EVENT_COLORS: [string, string][] = [
  ["1", "#7986cb"], // Lavender
  ["2", "#33b679"], // Sage
  ["3", "#8e24aa"], // Grape
  ["4", "#e67c73"], // Flamingo
  ["5", "#f6c026"], // Banana
  ["6", "#f5511d"], // Tangerine
  ["7", "#039be5"], // Peacock
  ["8", "#616161"], // Graphite
  ["9", "#3f51b5"], // Blueberry
  ["10", "#0b8043"], // Basil
  ["11", "#d60000"], // Tomato
];

/**
 * Builds the deterministic Google event id for a (booking, room) pair. Hex
 * encoding keeps the id inside Google's required base32hex alphabet
 * (`[a-v0-9]`) regardless of what characters the cuids contain.
 */
export function roomEventId(bookingId: string, roomId: string): string {
  return Buffer.from(`${bookingId}:${roomId}`, "utf8").toString("hex");
}

/**
 * Reverses {@link roomEventId}. Returns `null` for ids we didn't create
 * (manually-added calendar events must never be touched by the reconcile).
 */
export function decodeRoomEventId(
  eventId: string
): { bookingId: string; roomId: string } | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(eventId)) {
    return null;
  }
  const decoded = Buffer.from(eventId, "hex").toString("utf8");
  const parts = decoded.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { bookingId: parts[0], roomId: parts[1] };
}

/**
 * Maps a room's hex color to the nearest of Google's 11 fixed event colors
 * (simple RGB distance). Returns `undefined` for missing/unparsable colors so
 * the event falls back to the calendar's default color.
 */
export function googleColorIdForHex(hex: string | null): string | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!match) {
    return undefined;
  }
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const [colorId, colorHex] of GOOGLE_EVENT_COLORS) {
    const cv = parseInt(colorHex.slice(1), 16);
    const dr = r - ((cv >> 16) & 0xff);
    const dg = g - ((cv >> 8) & 0xff);
    const db_ = b - (cv & 0xff);
    const distance = dr * dr + dg * dg + db_ * db_;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = colorId;
    }
  }
  return best;
}

/** The booking shape the event builder needs (selected in the loaders below). */
type BookingForCalendar = {
  id: string;
  name: string;
  from: Date | null;
  to: Date | null;
  custodianUser: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
  custodianTeamMember: { name: string } | null;
  _count: { assets: number };
};

/** The room shape the event builder needs. */
type RoomForCalendar = { id: string; name: string; color: string | null };

/** Shared select for loading a booking with everything the event needs. */
const BOOKING_FOR_CALENDAR_SELECT = {
  id: true,
  name: true,
  from: true,
  to: true,
  status: true,
  custodianUser: {
    select: { firstName: true, lastName: true, email: true },
  },
  custodianTeamMember: { select: { name: true } },
  rooms: { select: { id: true, name: true, color: true } },
  _count: { select: { assets: true } },
} as const;

/**
 * Builds the Google event resource for one (booking, room) pair.
 *
 * @returns The event, or `null` when the booking has no usable time window
 */
export function buildRoomEvent(
  booking: BookingForCalendar,
  room: RoomForCalendar
): GoogleCalendarEvent | null {
  if (!booking.from || !booking.to) {
    return null;
  }

  const custodianName =
    resolveUserDisplayName(booking.custodianUser) ||
    booking.custodianTeamMember?.name ||
    "Unassigned";
  const bookingUrl = `${SERVER_URL}/bookings/${booking.id}`;
  const assetCount = booking._count.assets;

  return {
    id: roomEventId(booking.id, room.id),
    summary: `${room.name} — ${booking.name}`,
    location: room.name,
    description:
      `Reserved by: ${custodianName}\n` +
      `Equipment on booking: ${assetCount} item${
        assetCount === 1 ? "" : "s"
      }\n\n` +
      `Open in BIG Shelf: ${bookingUrl}`,
    start: { dateTime: new Date(booking.from).toISOString() },
    end: { dateTime: new Date(booking.to).toISOString() },
    colorId: googleColorIdForHex(room.color),
    status: "confirmed",
    extendedProperties: {
      private: { shelfBookingId: booking.id, shelfRoomId: room.id },
    },
    source: { title: "BIG Shelf booking", url: bookingUrl },
  };
}

/**
 * Best-effort push: creates/updates the Google events for every room on the
 * booking, IF the booking is currently in an active (calendar-worthy) status.
 * No-ops for drafts, completed/cancelled bookings, room-less bookings, or when
 * the integration isn't configured. NEVER throws — hook this after booking
 * mutations without fear.
 *
 * @param args.bookingId - The booking whose room events should be refreshed
 */
export async function upsertBookingRoomEvents({
  bookingId,
}: {
  bookingId: string;
}): Promise<void> {
  try {
    if (!isGoogleCalendarConfigured()) {
      return;
    }

    const booking = await db.booking.findUnique({
      // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: bookingId comes from server-side booking-service hooks (the mutation already org-validated it), never from request input; result is only pushed to the org-agnostic shared calendar
      where: { id: bookingId },
      select: BOOKING_FOR_CALENDAR_SELECT,
    });
    if (
      !booking ||
      !ACTIVE_STATUSES.includes(booking.status) ||
      booking.rooms.length === 0
    ) {
      return;
    }

    for (const room of booking.rooms) {
      const event = buildRoomEvent(booking, room);
      if (event) {
        await upsertCalendarEvent(event);
      }
    }
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message: "Failed to push room booking to Google Calendar",
        additionalData: { bookingId },
        label,
      })
    );
  }
}

/**
 * Best-effort removal: deletes the Google events for the given rooms of a
 * booking. When `roomIds` is omitted, the booking's currently-attached rooms
 * are looked up (fine for cancel/revert, where the rows still exist); pass
 * them explicitly when the booking or the links are about to be / already
 * deleted. NEVER throws.
 *
 * @param args.bookingId - The booking whose room events should be removed
 * @param args.roomIds - Rooms to remove events for (default: all attached)
 */
export async function deleteBookingRoomEvents({
  bookingId,
  roomIds,
}: {
  bookingId: string;
  roomIds?: string[];
}): Promise<void> {
  try {
    if (!isGoogleCalendarConfigured()) {
      return;
    }

    let ids = roomIds;
    if (!ids) {
      const booking = await db.booking.findUnique({
        // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: bookingId comes from server-side booking-service hooks (the mutation already org-validated it), never from request input; only room ids are read to derive event ids
        where: { id: bookingId },
        select: { rooms: { select: { id: true } } },
      });
      ids = booking?.rooms.map((room) => room.id) ?? [];
    }

    for (const roomId of ids) {
      await deleteCalendarEvent(roomEventId(bookingId, roomId));
    }
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message: "Failed to remove room booking from Google Calendar",
        additionalData: { bookingId, roomIds },
        label,
      })
    );
  }
}

/** Outcome of the admin "Sync now" reconcile. */
export type RoomCalendarResyncResult = {
  /** Events created/refreshed for active room bookings. */
  synced: number;
  /** Upcoming events removed because their booking no longer needs them. */
  pruned: number;
};

/**
 * Admin reconcile: pushes every active room booking of the organization to the
 * calendar, then prunes upcoming events we created whose booking is gone, no
 * longer active, or no longer includes that room. Manually-created calendar
 * events (non-decodable ids) are never touched; past events are never listed,
 * so history stays intact. THROWS on configuration/API errors so the settings
 * page can show them.
 *
 * @param args.organizationId - The org whose room bookings are pushed
 * @returns Counts of synced and pruned events
 * @throws {ShelfError} 503 when the integration isn't configured; API errors otherwise
 */
export async function resyncRoomCalendar({
  organizationId,
}: {
  organizationId: string;
}): Promise<RoomCalendarResyncResult> {
  if (!isGoogleCalendarConfigured()) {
    throw new ShelfError({
      cause: null,
      title: "Google Calendar is not configured",
      message:
        "Set GOOGLE_CALENDAR_SA_EMAIL, GOOGLE_CALENDAR_SA_PRIVATE_KEY and GOOGLE_ROOM_CALENDAR_ID to enable the room calendar.",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }

  // 1) Push every active room booking in this workspace.
  const bookings = await db.booking.findMany({
    where: {
      organizationId,
      status: { in: ACTIVE_STATUSES },
      rooms: { some: {} },
    },
    select: BOOKING_FOR_CALENDAR_SELECT,
  });

  let synced = 0;
  for (const booking of bookings) {
    for (const room of booking.rooms) {
      const event = buildRoomEvent(booking, room);
      if (event) {
        await upsertCalendarEvent(event);
        synced++;
      }
    }
  }

  // 2) Prune upcoming events whose (booking, room) pair shouldn't exist
  //    anymore. Decodable ids only — human-created events are left alone.
  const upcomingIds = await listUpcomingCalendarEventIds();
  const decodable = upcomingIds
    .map((eventId) => ({ eventId, key: decodeRoomEventId(eventId) }))
    .filter(
      (
        entry
      ): entry is { eventId: string; key: NonNullable<typeof entry.key> } =>
        entry.key !== null
    );

  // Load the referenced bookings in one query — deliberately NOT org-scoped:
  // the calendar is shared infrastructure, and another org's still-active
  // events must not be pruned just because this org ran the reconcile.
  const referencedBookings = await db.booking.findMany({
    where: { id: { in: [...new Set(decodable.map((d) => d.key.bookingId))] } },
    select: { id: true, status: true, rooms: { select: { id: true } } },
  });
  const bookingById = new Map(referencedBookings.map((b) => [b.id, b]));

  let pruned = 0;
  for (const { eventId, key } of decodable) {
    const booking = bookingById.get(key.bookingId);
    const shouldExist =
      booking &&
      ACTIVE_STATUSES.includes(booking.status) &&
      booking.rooms.some((room) => room.id === key.roomId);
    if (!shouldExist) {
      await deleteCalendarEvent(eventId);
      pruned++;
    }
  }

  return { synced, pruned };
}
