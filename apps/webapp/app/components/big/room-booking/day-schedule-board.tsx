/**
 * DayScheduleBoard — the member dashboard's interactive room schedule.
 *
 * The light-theme, phone-friendly twin of the kiosk wallboard's day-picker +
 * room timelines (see `routes/kiosk.tsx`): a tappable "next 7 days" strip
 * drives which day the per-room hour timelines show, and every free hour cell
 * is a link into that room's booking form with the slot's start time
 * prefilled (`/reserve/rooms/:roomId?start=…`). Closed days (from the org's
 * Working Hours, via the kiosk closed-days feed) are marked on the strip and
 * block slot links so members don't try to book them.
 *
 * Anonymized by construction: busy blocks render "Reserved" — feed this
 * component data from `getRoomsWithSchedule` WITHOUT `includeDetails`, so no
 * booking or member names ever reach the client.
 *
 * Responsive: the timelines live in a horizontal scroll container with a
 * minimum width, so phones swipe the day sideways while the day strip and
 * room names stay put.
 *
 * NOTE: render inside `<ClientOnly>` — "today" and past-slot shading come
 * from the viewer's clock/timezone, which would mismatch during SSR.
 *
 * @see {@link file://./../../../routes/_layout+/reserve._index.tsx} — the dashboard
 * @see {@link file://./../../../routes/kiosk.tsx} — the dark wallboard twin
 * @see {@link file://./schedule.ts} — the shared date math
 */
import { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Link } from "react-router";
import type { KioskClosedDays } from "~/modules/big-kiosk-content/shared";
import { isDateClosed } from "~/modules/big-kiosk-content/shared";
import { useHints } from "~/utils/client-hints";
import { tw } from "~/utils/tw";
import { RoomStatusChip } from "./room-status-chip";
import type { ClientRoomSchedule } from "./schedule";
import {
  overlapsAnyWindow,
  toDateTimeLocalValue,
  toDT,
  windowsOnDay,
} from "./schedule";

/** The visible day window of the timelines (24h clock; matches the kiosk). */
const BOARD_START_HOUR = 8;
const BOARD_END_HOUR = 22;
const BOARD_HOURS = BOARD_END_HOUR - BOARD_START_HOUR;

/**
 * The board: day strip on top, one tappable timeline per room below.
 *
 * @param props.rooms - Rooms with ANONYMIZED schedules (no names in windows)
 * @param props.closedDays - The org's closed-days feed (`getKioskClosedDays`)
 */
export function DayScheduleBoard({
  rooms,
  closedDays,
}: {
  rooms: ClientRoomSchedule[];
  closedDays: KioskClosedDays;
}) {
  const { timeZone } = useHints();
  const now = DateTime.now().setZone(timeZone);
  const [selectedDay, setSelectedDay] = useState(() => now.startOf("day"));
  const isTodaySelected = selectedDay.hasSame(now, "day");
  const scrollRef = useRef<HTMLDivElement>(null);

  // On phones only ~6 of the 14 board hours fit, so when today is shown,
  // scroll the timelines to around "now" — the earlier hours are past and
  // unbookable anyway. Future days stay at the 8am start.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !isTodaySelected) return;
    const current = DateTime.now().setZone(timeZone);
    const fraction = Math.min(
      Math.max(
        (current.hour + current.minute / 60 - BOARD_START_HOUR) / BOARD_HOURS,
        0
      ),
      1
    );
    container.scrollLeft = Math.max(
      0,
      fraction * container.scrollWidth - container.clientWidth / 3
    );
  }, [isTodaySelected, timeZone]);

  /** The next 7 days with their reservation count + closed flag. */
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = now.startOf("day").plus({ days: i });
    const count = rooms.reduce(
      (total, room) =>
        total + windowsOnDay(room.busyWindows, day, timeZone).length,
      0
    );
    const closed = isDateClosed(
      closedDays,
      day.toFormat("yyyy-MM-dd"),
      day.weekday % 7
    );
    return { day, count, closed };
  });

  const selectedKey = selectedDay.toFormat("yyyy-MM-dd");
  const selectedClosed = isDateClosed(
    closedDays,
    selectedKey,
    selectedDay.weekday % 7
  );
  const closedReason =
    closedDays.closedOverrides.find((override) => override.date === selectedKey)
      ?.reason ?? null;

  return (
    <div>
      {/* Day strip */}
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {days.map(({ day, count, closed }) => {
          const isSelected = day.hasSame(selectedDay, "day");
          const isToday = day.hasSame(now, "day");
          return (
            <button
              key={day.toISODate()}
              type="button"
              onClick={() => setSelectedDay(day)}
              aria-pressed={isSelected}
              aria-label={`Show ${day.toFormat("cccc, MMMM d")}${
                closed ? " (closed)" : ""
              }`}
              className={tw(
                "flex flex-col items-center rounded-lg border py-2 transition",
                isSelected
                  ? "border-primary-300 bg-primary-50 ring-1 ring-primary-300"
                  : closed
                  ? "border-error-100 bg-error-25 hover:border-error-200"
                  : "border-gray-200 bg-white hover:border-primary-200 hover:bg-gray-50"
              )}
            >
              <span className="text-xs uppercase leading-none text-gray-500">
                {day.toFormat("EEE")}
              </span>
              <span
                className={tw(
                  "mt-1 text-sm leading-none",
                  isSelected || isToday
                    ? "font-semibold text-gray-900"
                    : "text-gray-700"
                )}
              >
                {day.day}
              </span>
              <span
                className={tw(
                  "mt-1 text-xs tabular-nums leading-none",
                  closed
                    ? "font-medium text-error-600"
                    : count > 0
                    ? "text-amber-600"
                    : "text-gray-300"
                )}
              >
                {closed ? "✕" : count > 0 ? count : "·"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-gray-400">
        Numbers show reservations that day · ✕ means BIG is closed
      </p>

      {/* Selected-day header */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-900">
          {isTodaySelected ? "Today" : selectedDay.toFormat("EEEE, MMMM d")}
        </p>
        {!isTodaySelected ? (
          <button
            type="button"
            onClick={() => setSelectedDay(now.startOf("day"))}
            className="text-xs font-medium text-primary-700 hover:text-primary-800"
          >
            Back to today
          </button>
        ) : null}
      </div>

      {/* Timelines (or the closed notice) */}
      {selectedClosed ? (
        <div
          role="status"
          className="mt-2 rounded-lg border border-error-200 bg-error-50 p-4 text-sm text-error-700"
        >
          <span className="font-medium">
            BIG is closed {selectedDay.toFormat("EEEE, MMMM d")}
          </span>
          {closedReason ? ` — ${closedReason}` : ""}. Pick another day to book a
          room.
        </div>
      ) : (
        <div ref={scrollRef} className="mt-2 overflow-x-auto pb-1">
          <div className="min-w-[560px]">
            <HourAxis />
            <div className="mt-1 flex flex-col gap-3">
              {rooms.map((room) => (
                <RoomDayTrack
                  key={room.id}
                  room={room}
                  selectedDay={selectedDay}
                  now={now}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The hour labels across the top of the timelines (every 2 hours). */
function HourAxis() {
  const labels = [];
  for (let hour = BOARD_START_HOUR; hour <= BOARD_END_HOUR; hour += 2) {
    labels.push(
      <span
        key={hour}
        className={tw(
          "absolute text-xs tabular-nums text-gray-400",
          // Keep the edge labels inside the container instead of centering
          // them on the boundary (where half the text would be cut off).
          hour === BOARD_START_HOUR
            ? ""
            : hour === BOARD_END_HOUR
            ? "-translate-x-full"
            : "-translate-x-1/2"
        )}
        style={{ left: `${((hour - BOARD_START_HOUR) / BOARD_HOURS) * 100}%` }}
      >
        {DateTime.fromObject({ hour }).toFormat("ha").toLowerCase()}
      </span>
    );
  }
  return <div className="relative h-4">{labels}</div>;
}

/**
 * One room's timeline for the selected day: the room's name + live status
 * above a track of hour cells. Free future cells link straight into the
 * booking form with the slot prefilled; busy windows overlay as "Reserved"
 * blocks; today gets past-shading and a "now" line.
 */
function RoomDayTrack({
  room,
  selectedDay,
  now,
}: {
  room: ClientRoomSchedule;
  selectedDay: DateTime;
  now: DateTime;
}) {
  const dayStart = selectedDay.startOf("day").plus({ hours: BOARD_START_HOUR });
  const dayEnd = selectedDay.startOf("day").plus({ hours: BOARD_END_HOUR });
  const isToday = selectedDay.hasSame(now, "day");

  /** Busy blocks clamped to the visible window, as % offsets. */
  const blocks = room.busyWindows.flatMap((window) => {
    const from = toDT(window.from);
    const to = toDT(window.to);
    const clampedFrom = from < dayStart ? dayStart : from;
    const clampedTo = to > dayEnd ? dayEnd : to;
    if (clampedTo <= clampedFrom) return [];
    const left =
      (clampedFrom.diff(dayStart, "hours").hours / BOARD_HOURS) * 100;
    const width =
      (clampedTo.diff(clampedFrom, "hours").hours / BOARD_HOURS) * 100;
    return [{ key: window.bookingId, left, width }];
  });

  /** The tappable hour grid: a cell is offered when free (and, today, future). */
  const cells = Array.from({ length: BOARD_HOURS }, (_, index) => {
    const cellStart = dayStart.plus({ hours: index });
    const cellEnd = cellStart.plus({ hours: 1 });
    const isPast = isToday && cellEnd <= now;
    const isFree =
      !isPast && !overlapsAnyWindow(room.busyWindows, cellStart, cellEnd);
    return { cellStart, isFree, isPast };
  });

  // Reservations that touch the selected day (drives the future-day status
  // text; today shows the live status chip instead).
  const dayReservationCount = room.busyWindows.filter((window) => {
    const from = toDT(window.from);
    const to = toDT(window.to);
    return from < dayEnd && to > dayStart;
  }).length;

  const nowOffset = isToday
    ? now.diff(dayStart, "hours").hours / BOARD_HOURS
    : -1;

  return (
    <div>
      {/* Identity + status — sticky so the name stays visible while the
          track scrolls sideways on phones */}
      <div className="sticky left-0 flex w-fit items-center gap-2">
        <span
          className="inline-block size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: room.color }}
          aria-hidden
        />
        <span className="truncate text-sm font-medium text-gray-900">
          {room.name}
        </span>
        {isToday ? (
          <RoomStatusChip availability={room.availability} />
        ) : (
          <span className="text-xs text-gray-500">
            {dayReservationCount > 0
              ? `${dayReservationCount} reservation${
                  dayReservationCount === 1 ? "" : "s"
                }`
              : "Open all day"}
          </span>
        )}
      </div>

      {/* Track */}
      <div className="relative mt-1 h-11 overflow-hidden rounded-md border border-gray-200 bg-gray-25">
        {/* Free-slot links / dead cells */}
        <div
          className="absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${BOARD_HOURS}, minmax(0, 1fr))`,
          }}
        >
          {cells.map(({ cellStart, isFree, isPast }) =>
            isFree ? (
              <Link
                key={cellStart.toISO()}
                to={`/reserve/rooms/${room.id}?start=${encodeURIComponent(
                  toDateTimeLocalValue(cellStart)
                )}`}
                aria-label={`Book ${room.name} at ${cellStart.toFormat(
                  "h a"
                )} on ${cellStart.toFormat("cccc, MMMM d")}`}
                className="group/cell flex items-center justify-center border-r border-gray-200/70 last:border-r-0 hover:bg-primary-50"
              >
                <span
                  className="text-sm leading-none text-gray-300 transition group-hover/cell:text-primary-600"
                  aria-hidden
                >
                  +
                </span>
              </Link>
            ) : (
              <div
                key={cellStart.toISO()}
                className={tw(
                  "border-r border-gray-200/70 last:border-r-0",
                  isPast ? "bg-gray-100" : ""
                )}
              />
            )
          )}
        </div>

        {/* Busy blocks (visual only — taps land on the cells beneath) */}
        {blocks.map((block) => (
          <div
            key={block.key}
            className="pointer-events-none absolute inset-y-1 flex items-center justify-center overflow-hidden rounded px-2"
            style={{
              left: `${block.left}%`,
              width: `${block.width}%`,
              backgroundColor: room.color,
              opacity: 0.85,
            }}
          >
            {block.width > 9 ? (
              <span className="truncate text-xs font-semibold text-white">
                Reserved
              </span>
            ) : null}
          </div>
        ))}

        {/* Now line (today only) */}
        {nowOffset >= 0 && nowOffset <= 1 ? (
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-error-500"
            style={{ left: `${nowOffset * 100}%` }}
            aria-hidden
          >
            <div className="absolute -left-1 -top-0.5 size-2 rounded-full bg-error-500" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
