/**
 * BIG Room Booking — server helpers
 *
 * Business logic for the dedicated room-booking experience: live room
 * schedules ("free until 3:00 PM"), hard double-booking prevention, the
 * create-and-reserve pipeline used by the member portal / staff pages / kiosk,
 * the week-ahead digest data, and the kiosk walk-up member lookup.
 *
 * This module is additive (BIG-only) per BIG-FORK.md — it composes existing
 * upstream booking services (`createBooking` → `updateBookingRooms` →
 * `reserveBooking`) rather than editing them, so every reservation created
 * here inherits the Neon membership gate (inside `createBooking`), the asset
 * conflict validation + reservation emails (inside `reserveBooking`), and the
 * Google Calendar room mirror (fired by `reserveBooking`).
 *
 * @see {@link file://./../../routes/_layout+/reserve.rooms.$roomId.tsx} — member booking form
 * @see {@link file://./../../routes/_layout+/rooms.$roomId_.book.tsx} — staff booking form
 * @see {@link file://./../../routes/_layout+/week-ahead.tsx} — the staff digest
 * @see {@link file://./../../routes/kiosk.tsx} — the wallboard
 * @see {@link file://./../booking/service.server.ts} — the composed upstream services
 */
import type { Booking, Organization, Room, User } from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import { DateTime } from "luxon";
import { BookingFormSchema } from "~/components/booking/forms/forms-schema";
import { db } from "~/database/db.server";
import { resolveReservationCustodian } from "~/modules/big-member-directory/service.server";
import {
  createBooking,
  deleteBooking,
  reserveBooking,
  updateBookingRooms,
} from "~/modules/booking/service.server";
import { getBookingSettingsForOrganization } from "~/modules/booking-settings/service.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import type { ClientHint } from "~/utils/client-hints";
import { getHints } from "~/utils/client-hints";
import type { ErrorLabel } from "~/utils/error";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import { parseData } from "~/utils/http.server";

const label: ErrorLabel = "Booking";

/** Fallback color for rooms that don't have one set. */
export const DEFAULT_ROOM_COLOR = "#6b7280";

/**
 * Booking statuses that occupy a room (block other reservations). DRAFT is
 * excluded on purpose: drafts are work-in-progress and upstream treats them as
 * non-blocking everywhere else.
 */
export const ROOM_BLOCKING_STATUSES: BookingStatus[] = [
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/**
 * One occupied window on a room's schedule. `bookingName` / `custodianName`
 * are only present when the caller asked for details (staff surfaces); member
 * and kiosk surfaces receive anonymized windows — "when", never "who".
 */
export type RoomBusyWindow = {
  bookingId: string;
  from: Date;
  to: Date;
  status: BookingStatus;
  bookingName?: string;
  custodianName?: string;
};

/**
 * Live availability of a room, derived from its busy windows:
 * - `state: "free"` — nothing on right now; `until` = the next reservation's
 *   start (or null if nothing upcoming inside the horizon).
 * - `state: "busy"` — a reservation is on right now; `until` = when it ends.
 */
export type RoomAvailabilityStatus = {
  state: "free" | "busy";
  until: Date | null;
};

/** A room together with its schedule over the requested horizon. */
export type RoomWithSchedule = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  /** Public URL of the room photo, or null when none is set. */
  imageUrl: string | null;
  assetCount: number;
  availability: RoomAvailabilityStatus;
  /** Active reservation windows within [now, now + horizonDays], sorted by start. */
  busyWindows: RoomBusyWindow[];
};

/**
 * Formats a booking custodian into a display name, preferring the linked user
 * account over the bare team-member record.
 */
function custodianDisplayName(booking: {
  custodianUser: { firstName: string | null; lastName: string | null } | null;
  custodianTeamMember: { name: string } | null;
}): string | undefined {
  if (booking.custodianUser) {
    const name = [
      booking.custodianUser.firstName,
      booking.custodianUser.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (name) return name;
  }
  return booking.custodianTeamMember?.name ?? undefined;
}

/**
 * Loads every room in the organization together with its live schedule:
 * current/next reservation state and all active reservation windows within the
 * horizon. Powers the room pickers, the rooms index status chips, the kiosk
 * timeline, and the member week strips.
 *
 * @param args.organizationId - The workspace to read rooms + bookings from
 * @param args.roomId - Optional: limit to a single room (its booking page)
 * @param args.horizonDays - How far ahead to load busy windows (default 14)
 * @param args.includeDetails - When true, windows carry booking + custodian
 *   names (staff surfaces). Leave false for member/kiosk surfaces so "who
 *   booked it" is never sent to the client.
 * @returns Rooms sorted by name, each with availability + busy windows
 * @throws {ShelfError} If the database read fails
 */
export async function getRoomsWithSchedule({
  organizationId,
  roomId,
  horizonDays = 14,
  includeDetails = false,
}: {
  organizationId: Organization["id"];
  roomId?: Room["id"];
  horizonDays?: number;
  includeDetails?: boolean;
}): Promise<RoomWithSchedule[]> {
  try {
    const now = new Date();
    const horizonEnd = new Date(
      now.getTime() + horizonDays * 24 * 60 * 60 * 1000
    );

    const rooms = await db.room.findMany({
      where: { organizationId, ...(roomId ? { id: roomId } : {}) },
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        imageUrl: true,
        _count: { select: { assets: true } },
        bookings: {
          where: {
            status: { in: ROOM_BLOCKING_STATUSES },
            // Overlaps the horizon window (strict: back-to-back is not overlap)
            from: { lt: horizonEnd },
            to: { gt: now },
          },
          select: {
            id: true,
            name: true,
            from: true,
            to: true,
            status: true,
            custodianUser: { select: { firstName: true, lastName: true } },
            custodianTeamMember: { select: { name: true } },
          },
          orderBy: { from: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    return rooms.map((room) => {
      const busyWindows: RoomBusyWindow[] = room.bookings.map((booking) => ({
        bookingId: booking.id,
        from: booking.from,
        to: booking.to,
        status: booking.status,
        ...(includeDetails
          ? {
              bookingName: booking.name,
              custodianName: custodianDisplayName(booking),
            }
          : {}),
      }));

      const current = busyWindows.find(
        (window) => window.from <= now && window.to > now
      );
      const next = busyWindows.find((window) => window.from > now);

      const availability: RoomAvailabilityStatus = current
        ? { state: "busy", until: current.to }
        : { state: "free", until: next?.from ?? null };

      return {
        id: room.id,
        name: room.name,
        description: room.description,
        color: room.color ?? DEFAULT_ROOM_COLOR,
        imageUrl: room.imageUrl,
        assetCount: room._count.assets,
        availability,
        busyWindows,
      };
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading room schedules",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Finds active bookings that occupy `roomId` during [from, to).
 *
 * Uses a strict-overlap rule (`existing.from < to && existing.to > from`) so
 * back-to-back reservations (one ending exactly when the next starts) are
 * allowed — unlike upstream's advisory picker filter, which treats touching
 * windows as clashes.
 *
 * @param args.organizationId - The caller's (validated) organization ID
 * @param args.roomId - The room to check (already proven in-org by callers)
 * @param args.from - Requested reservation start
 * @param args.to - Requested reservation end
 * @returns The clashing bookings (empty when the slot is free)
 */
export async function getRoomBookingConflicts({
  organizationId,
  roomId,
  from,
  to,
}: {
  organizationId: Organization["id"];
  roomId: Room["id"];
  from: Date;
  to: Date;
}) {
  return db.booking.findMany({
    where: {
      organizationId,
      rooms: { some: { id: roomId } },
      status: { in: ROOM_BLOCKING_STATUSES },
      from: { lt: to },
      to: { gt: from },
    },
    select: { id: true, from: true, to: true },
    orderBy: { from: "asc" },
  });
}

/**
 * Creates and immediately reserves a room booking — the one-step "book a room"
 * used by the member portal, the staff room pages, and the kiosk.
 *
 * Pipeline (composing upstream services so nothing is re-implemented):
 * 1. Verify the room belongs to the org.
 * 2. **Hard conflict check** — reject with a 409 if the room is already
 *    reserved during the window (upstream only greys conflicts out in a
 *    picker; this is the server-side enforcement the room flow needs).
 * 3. `createBooking` — creates the DRAFT and runs the Neon membership gate
 *    against the creator.
 * 4. `updateBookingRooms` — attaches the room, pulling in its equipment.
 * 5. `reserveBooking` — DRAFT→RESERVED: validates the pulled-in equipment for
 *    conflicts, emails the custodian, and mirrors to the Google room calendar.
 *
 * If step 4/5 fails, the DRAFT is best-effort deleted so members never see an
 * orphaned draft they didn't knowingly create.
 *
 * @returns The reserved booking
 * @throws {ShelfError} 409 when the room is taken; membership/asset-conflict
 *   errors bubble up from the composed services
 */
export async function createRoomReservation({
  organizationId,
  roomId,
  name,
  description,
  from,
  to,
  creatorId,
  custodianTeamMemberId,
  custodianUserId,
  hints,
  isSelfServiceOrBase,
}: {
  organizationId: Organization["id"];
  roomId: Room["id"];
  name: Booking["name"];
  description?: Booking["description"];
  from: Date;
  to: Date;
  /** The authenticated user creating the reservation (membership gate target). */
  creatorId: User["id"];
  /** The custodian — already validated to belong to `organizationId` by the caller. */
  custodianTeamMemberId: string;
  custodianUserId: string | null;
  hints: ClientHint;
  isSelfServiceOrBase: boolean;
}) {
  // 1. Prove the room is in this org before anything else (IDOR guard —
  // roomId comes from the URL).
  const room = await db.room
    .findFirstOrThrow({
      where: { id: roomId, organizationId },
      select: { id: true, name: true },
    })
    .catch((cause) => {
      throw new ShelfError({
        cause,
        title: "Room not found",
        message:
          "The room you are trying to book does not exist in this workspace.",
        additionalData: { roomId, organizationId },
        status: 404,
        label,
        shouldBeCaptured: false,
      });
    });

  // 2. Hard double-booking prevention.
  const conflicts = await getRoomBookingConflicts({
    organizationId,
    roomId,
    from,
    to,
  });
  if (conflicts.length > 0) {
    throw new ShelfError({
      cause: null,
      title: "Room unavailable",
      message: `${room.name} is already reserved during that time. Pick a different time — the schedule shows when it's free.`,
      additionalData: {
        roomId,
        from,
        to,
        conflictIds: conflicts.map((c) => c.id),
      },
      status: 409,
      label,
      shouldBeCaptured: false,
    });
  }

  // 3. DRAFT (runs the Neon membership gate against creatorId).
  const draft = await createBooking({
    booking: {
      name,
      description: description ?? null,
      from,
      to,
      custodianTeamMemberId,
      custodianUserId,
      organizationId,
      creatorId,
      tags: [],
    },
    assetIds: [],
    hints,
  });

  try {
    // 4. Attach the room; this also pulls the room's equipment into the booking.
    await updateBookingRooms({
      id: draft.id,
      organizationId,
      roomIds: [roomId],
      userId: creatorId,
    });

    // 5. Reserve: asset-conflict validation, custodian email, calendar mirror.
    return await reserveBooking({
      id: draft.id,
      organizationId,
      name,
      description: description ?? null,
      from,
      to,
      custodianTeamMemberId,
      custodianUserId,
      hints,
      isSelfServiceOrBase,
      tags: [],
      userId: creatorId,
    });
  } catch (cause) {
    // Roll back the draft so the failed attempt leaves nothing behind. The
    // deletion is best-effort: the original error is what the user must see.
    await deleteBooking(
      { id: draft.id, organizationId },
      hints,
      creatorId
    ).catch(() => null);

    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while reserving the room.",
      additionalData: { roomId, organizationId, from, to },
      label,
    });
  }
}

/**
 * Parses + validates a room-booking form submission — the shared half of the
 * member (`/reserve/rooms/:roomId`) and staff (`/rooms/:roomId/book`) actions.
 *
 * Reuses upstream `BookingFormSchema` so the org's working hours, start-time
 * buffer, and max-booking-length policies apply exactly as they do in the
 * regular booking form (staff bypass buffer/length, as upstream does). The
 * org's "tags required" policy is intentionally NOT applied: the room flow
 * has no tag UI, and tags can be added on the booking page afterwards.
 *
 * SECURITY: the submitted custodian is proven to belong to the org, and
 * restricted roles (MEMBER / SELF_SERVICE / BASE) may only book for
 * themselves — a forged custodian in the hidden field is rejected.
 *
 * @returns The validated fields, ready for {@link createRoomReservation}
 * @throws {ShelfError} Zod validation errors (per-field) or custodian errors
 */
export async function parseRoomBookingForm({
  request,
  formData,
  organizationId,
  userId,
  isSelfServiceOrBase,
}: {
  request: Request;
  formData: FormData;
  organizationId: Organization["id"];
  userId: User["id"];
  isSelfServiceOrBase: boolean;
}) {
  const hints = getHints(request);
  const [workingHours, bookingSettings] = await Promise.all([
    getWorkingHoursForOrganization(organizationId),
    getBookingSettingsForOrganization(organizationId),
  ]);

  const payload = parseData(
    formData,
    BookingFormSchema({
      hints,
      action: "new",
      workingHours,
      bookingSettings: {
        ...bookingSettings,
        // why: no tag UI in the room flow — see the function JSDoc.
        tagsRequired: false,
      },
      isAdminOrOwner: !isSelfServiceOrBase,
    }),
    {
      // Expected user-input validation — a 400, not a server error.
      shouldBeCaptured: false,
      additionalData: { userId, organizationId },
    }
  );

  const { name, custodian, description, startDate, endDate } = payload;

  if (!startDate || !endDate) {
    throw new ShelfError({
      cause: null,
      message: "Start and end times are required.",
      additionalData: { userId, organizationId },
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  /**
   * Prove the custodian belongs to this org (the id is client input).
   *
   * BIG: the staff room-booking form's picker also offers members who exist
   * only in the Neon directory, so this resolves such a pick into a real
   * TeamMember record. For an ordinary id it is a plain org-scoped lookup.
   * @see ~/modules/big-member-directory/service.server.ts
   */
  const custodianFromDb = await resolveReservationCustodian({
    organizationId,
    custodianId: custodian.id,
    // Members book rooms for themselves only; staff may pick anyone.
    allowDirectory: !isSelfServiceOrBase,
  });

  // Restricted roles book for themselves only.
  if (isSelfServiceOrBase && custodianFromDb.userId !== userId) {
    throw new ShelfError({
      cause: null,
      message: "You can only make reservations for yourself.",
      additionalData: { userId, custodian },
      label,
      status: 403,
      shouldBeCaptured: false,
    });
  }

  return {
    name,
    description: description ?? null,
    from: startDate,
    to: endDate,
    custodianTeamMemberId: custodianFromDb.id,
    custodianUserId: custodianFromDb.userId ?? null,
  };
}

/** A digest row for one booking, shaped for the week-ahead + kiosk surfaces. */
export type DigestBooking = {
  id: string;
  name: string;
  status: BookingStatus;
  from: Date;
  to: Date;
  custodianName?: string;
  assetCount: number;
  rooms: { id: string; name: string; color: string }[];
};

/** One day of the week-ahead digest. `date` is the day's start in the org TZ. */
export type DigestDay = {
  date: Date;
  /** Active bookings that occupy a room at some point during this day. */
  roomBookings: DigestBooking[];
  /** Reserved bookings scheduled to start (equipment going out) this day. */
  departures: DigestBooking[];
  /** Active bookings due back (ending) this day. */
  returns: DigestBooking[];
};

/** The full week-ahead digest payload. */
export type WeekAheadDigest = {
  start: Date;
  end: Date;
  days: DigestDay[];
  /** Bookings past their end date and not yet checked in. */
  overdue: DigestBooking[];
  totals: {
    roomBookings: number;
    departures: number;
    returns: number;
    overdue: number;
  };
};

/** Prisma select used for every digest booking row. */
const DIGEST_BOOKING_SELECT = {
  id: true,
  name: true,
  status: true,
  from: true,
  to: true,
  custodianUser: { select: { firstName: true, lastName: true } },
  custodianTeamMember: { select: { name: true } },
  _count: { select: { assets: true } },
  rooms: { select: { id: true, name: true, color: true } },
} as const;

/** Maps a digest query row into the serializable {@link DigestBooking} shape. */
function toDigestBooking(booking: {
  id: string;
  name: string;
  status: BookingStatus;
  from: Date;
  to: Date;
  custodianUser: { firstName: string | null; lastName: string | null } | null;
  custodianTeamMember: { name: string } | null;
  _count: { assets: number };
  rooms: { id: string; name: string; color: string | null }[];
}): DigestBooking {
  return {
    id: booking.id,
    name: booking.name,
    status: booking.status,
    from: booking.from,
    to: booking.to,
    custodianName: custodianDisplayName(booking),
    assetCount: booking._count.assets,
    rooms: booking.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      color: room.color ?? DEFAULT_ROOM_COLOR,
    })),
  };
}

/**
 * Builds the week-ahead digest: for each of the next `days` days (in the
 * viewer's timezone), the room reservations happening, the equipment
 * departures (reserved bookings starting), and the returns due (active
 * bookings ending) — plus the current overdue list.
 *
 * One bounded query per concern; day bucketing happens in memory so a booking
 * spanning several days appears under each day it occupies.
 *
 * @param args.organizationId - The workspace to read from
 * @param args.timeZone - IANA zone used to cut day boundaries (from client hints)
 * @param args.days - Number of days to include (default 7)
 * @returns The digest, ready for the printable page and the kiosk
 * @throws {ShelfError} If a database read fails
 */
export async function getWeekAheadDigest({
  organizationId,
  timeZone,
  days = 7,
}: {
  organizationId: Organization["id"];
  timeZone: string;
  days?: number;
}): Promise<WeekAheadDigest> {
  try {
    const start = DateTime.now().setZone(timeZone).startOf("day");
    const end = start.plus({ days });
    const startDate = start.toJSDate();
    const endDate = end.toJSDate();
    const now = new Date();

    const [roomBookings, departures, returns, overdue] = await Promise.all([
      // Bookings occupying a room at some point inside the window.
      db.booking.findMany({
        where: {
          organizationId,
          status: { in: ROOM_BLOCKING_STATUSES },
          rooms: { some: {} },
          from: { lt: endDate },
          to: { gt: startDate },
        },
        select: DIGEST_BOOKING_SELECT,
        orderBy: { from: "asc" },
      }),
      // Equipment going out: reserved bookings that start inside the window.
      db.booking.findMany({
        where: {
          organizationId,
          status: BookingStatus.RESERVED,
          from: { gte: startDate, lt: endDate },
        },
        select: DIGEST_BOOKING_SELECT,
        orderBy: { from: "asc" },
      }),
      // Due back: active bookings that end inside the window.
      db.booking.findMany({
        where: {
          organizationId,
          status: { in: ROOM_BLOCKING_STATUSES },
          to: { gte: startDate, lt: endDate },
        },
        select: DIGEST_BOOKING_SELECT,
        orderBy: { to: "asc" },
      }),
      // Overdue right now (regardless of window).
      db.booking.findMany({
        where: {
          organizationId,
          status: BookingStatus.OVERDUE,
          to: { lt: now },
        },
        select: DIGEST_BOOKING_SELECT,
        orderBy: { to: "asc" },
      }),
    ]);

    const digestDays: DigestDay[] = [];
    for (let i = 0; i < days; i++) {
      const dayStart = start.plus({ days: i });
      const dayEnd = dayStart.plus({ days: 1 });
      const dayStartDate = dayStart.toJSDate();
      const dayEndDate = dayEnd.toJSDate();

      digestDays.push({
        date: dayStartDate,
        roomBookings: roomBookings
          .filter(
            (booking) => booking.from < dayEndDate && booking.to > dayStartDate
          )
          .map(toDigestBooking),
        departures: departures
          .filter(
            (booking) =>
              booking.from >= dayStartDate && booking.from < dayEndDate
          )
          .map(toDigestBooking),
        returns: returns
          .filter(
            (booking) => booking.to >= dayStartDate && booking.to < dayEndDate
          )
          .map(toDigestBooking),
      });
    }

    return {
      start: startDate,
      end: endDate,
      days: digestDays,
      overdue: overdue.map(toDigestBooking),
      totals: {
        roomBookings: roomBookings.length,
        departures: departures.length,
        returns: returns.length,
        overdue: overdue.length,
      },
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while building the week-ahead digest",
      additionalData: { organizationId, timeZone },
      label,
    });
  }
}

/**
 * Resolves a walk-up kiosk booking's custodian by membership email: the email
 * must belong to a user who is part of this organization AND has an active
 * (non-deleted) team-member record. Returns null when either is missing so
 * the kiosk can show a friendly "email not recognized" message instead of
 * leaking whether an email exists at all.
 *
 * @param args.organizationId - The kiosk's organization
 * @param args.email - The email typed on the kiosk (untrusted input)
 * @returns `{ user, teamMember }` or null when the email can't book here
 */
export async function findOrgMemberByEmail({
  organizationId,
  email,
}: {
  organizationId: Organization["id"];
  email: string;
}) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const user = await db.user.findFirst({
    where: {
      email: { equals: normalized, mode: "insensitive" },
      userOrganizations: { some: { organizationId } },
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!user) return null;

  const teamMember = await db.teamMember.findFirst({
    where: { organizationId, userId: user.id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!teamMember) return null;

  return { user, teamMember };
}
