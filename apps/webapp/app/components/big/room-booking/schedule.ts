/**
 * Room-booking schedule helpers (client-safe)
 *
 * Pure date math shared by the room-booking UI: the status chips, week
 * strips, day-schedule panels, and the kiosk timeline. Server modules must
 * not import from here (and this file must not import server code) — it runs
 * in the browser.
 *
 * Loader payloads may deliver dates as ISO strings or real `Date` objects
 * depending on the serialization path, so every helper accepts both via
 * {@link toDT}.
 *
 * @see {@link file://./../../../modules/big-room-booking/service.server.ts} — produces the data these helpers consume
 */
import { DateTime } from "luxon";

/** A room's busy window as it arrives from a loader (dates may be serialized). */
export type ClientBusyWindow = {
  bookingId: string;
  from: string | Date;
  to: string | Date;
  status: string;
  bookingName?: string;
  custodianName?: string;
};

/** A room + schedule as it arrives from a loader. */
export type ClientRoomSchedule = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  /** Public URL of the room photo, or null when none is set. */
  imageUrl: string | null;
  assetCount: number;
  availability: { state: "free" | "busy"; until: string | Date | null };
  busyWindows: ClientBusyWindow[];
};

/**
 * Normalizes a loader-provided date (ISO string or Date) into a Luxon
 * DateTime in the given zone.
 *
 * @param value - The date value from loader data
 * @param zone - IANA timezone (defaults to the runtime's local zone)
 */
export function toDT(value: string | Date, zone?: string): DateTime {
  const dt =
    typeof value === "string"
      ? DateTime.fromISO(value)
      : DateTime.fromJSDate(value);
  return zone ? dt.setZone(zone) : dt;
}

/**
 * Returns the busy windows that overlap the given calendar day (in `zone`),
 * sorted by start time.
 *
 * @param windows - The room's busy windows
 * @param day - Any instant within the day of interest
 * @param zone - IANA timezone used to cut the day's boundaries
 */
export function windowsOnDay(
  windows: ClientBusyWindow[],
  day: DateTime,
  zone: string
): ClientBusyWindow[] {
  const dayStart = day.setZone(zone).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });

  return windows
    .filter((window) => {
      const from = toDT(window.from, zone);
      const to = toDT(window.to, zone);
      return from < dayEnd && to > dayStart;
    })
    .sort(
      (a, b) => toDT(a.from, zone).toMillis() - toDT(b.from, zone).toMillis()
    );
}

/**
 * Total booked hours of a room within the given calendar day (clamped to the
 * day's boundaries so multi-day bookings only count their in-day portion).
 *
 * @returns Hours (fractional) between 0 and 24
 */
export function bookedHoursOnDay(
  windows: ClientBusyWindow[],
  day: DateTime,
  zone: string
): number {
  const dayStart = day.setZone(zone).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });

  let totalMs = 0;
  for (const window of windows) {
    const from = toDT(window.from, zone);
    const to = toDT(window.to, zone);
    const clampedFrom = from < dayStart ? dayStart : from;
    const clampedTo = to > dayEnd ? dayEnd : to;
    if (clampedTo > clampedFrom) {
      totalMs += clampedTo.toMillis() - clampedFrom.toMillis();
    }
  }
  return totalMs / (1000 * 60 * 60);
}

/**
 * True when [from, to) overlaps any busy window (strict overlap — touching
 * boundaries, i.e. back-to-back reservations, do not overlap). Mirrors the
 * server-side rule in `getRoomBookingConflicts` so the client warning and the
 * server rejection always agree.
 */
export function overlapsAnyWindow(
  windows: ClientBusyWindow[],
  from: DateTime,
  to: DateTime
): boolean {
  return windows.some((window) => {
    const windowFrom = toDT(window.from);
    const windowTo = toDT(window.to);
    return windowFrom < to && windowTo > from;
  });
}

/**
 * Formats a wire value for a `datetime-local` input (`yyyy-MM-dd'T'HH:mm`) in
 * the given zone.
 */
export function toDateTimeLocalValue(dt: DateTime): string {
  return dt.toFormat("yyyy-MM-dd'T'HH:mm");
}
