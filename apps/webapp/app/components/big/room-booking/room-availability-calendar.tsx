/**
 * RoomAvailabilityCalendar — the member dashboard's embedded full calendar.
 *
 * A FullCalendar month/week view of every room's reservations, rendered
 * directly on the page (successor of the old expand-to-dialog widget). Days
 * BIG is closed — from the org's Working Hours via the kiosk closed-days
 * feed — are shaded red as background events so members don't plan around
 * them.
 *
 * PRIVACY: events arrive pre-anonymized from `getRoomAvailability` (titles
 * are room names; no booking or member names ever reach this component).
 *
 * @see {@link file://./../../../modules/big-member/service.server.ts} — getRoomAvailability
 * @see {@link file://./../../../modules/big-kiosk-content/shared.ts} — KioskClosedDays
 * @see {@link file://./../../../routes/_layout+/reserve._index.tsx} — the dashboard
 */
import dayGridPlugin from "@fullcalendar/daygrid";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { DateTime } from "luxon";
import { ClientOnly } from "remix-utils/client-only";
import { Spinner } from "~/components/shared/spinner";
import type { KioskClosedDays } from "~/modules/big-kiosk-content/shared";
import { isDateClosed } from "~/modules/big-kiosk-content/shared";
import { useHints } from "~/utils/client-hints";

/** A pre-anonymized calendar event (see `RoomAvailabilityEvent`). */
export type RoomEvent = {
  id: string;
  title: string;
  start: string | Date;
  end: string | Date;
  backgroundColor: string;
  borderColor: string;
};

/**
 * How far ahead closed-day shading is generated. Matches the horizon of the
 * closed-overrides feed (`getKioskClosedDays`), which only carries overrides
 * up to ~2 months out.
 */
const CLOSED_SHADE_DAYS = 62;

/** Shading color for closed days (error-400; FullCalendar dims bg events). */
const CLOSED_SHADE_COLOR = "#f97066";

/**
 * Builds background events for every closed day in the shading window, in
 * the viewer's timezone. FullCalendar renders all-day background events only
 * in dayGrid views and TIMED background events only in timeGrid views, so
 * each closed day gets BOTH: an all-day event (shades the month cell) and a
 * midnight-to-midnight timed event (shades the whole week-view column).
 * Runs client-side only (inside `<ClientOnly>`) because "today" depends on
 * the viewer's clock.
 */
function buildClosedBackgroundEvents(
  closedDays: KioskClosedDays,
  timeZone: string
) {
  if (!closedDays.enabled) return [];

  const today = DateTime.now().setZone(timeZone).startOf("day");
  const events = [];
  for (let i = 0; i < CLOSED_SHADE_DAYS; i++) {
    const day = today.plus({ days: i });
    if (isDateClosed(closedDays, day.toFormat("yyyy-MM-dd"), day.weekday % 7)) {
      // Month (dayGrid) shading.
      events.push({
        id: `closed-${day.toISODate()}`,
        start: day.toISODate() ?? undefined,
        allDay: true,
        display: "background" as const,
        backgroundColor: CLOSED_SHADE_COLOR,
      });
      // Week (timeGrid) column shading.
      events.push({
        id: `closed-timed-${day.toISODate()}`,
        start: day.toISO() ?? undefined,
        end: day.plus({ days: 1 }).toISO() ?? undefined,
        display: "background" as const,
        backgroundColor: CLOSED_SHADE_COLOR,
      });
    }
  }
  return events;
}

/**
 * The calendar with its room color key.
 *
 * @param props.rooms - Rooms for the legend (id/name/color used)
 * @param props.events - Anonymized reservation events (`getRoomAvailability`)
 * @param props.closedDays - The org's closed-days feed (`getKioskClosedDays`)
 */
export function RoomAvailabilityCalendar({
  rooms,
  events,
  closedDays,
}: {
  rooms: { id: string; name: string; color: string }[];
  events: RoomEvent[];
  closedDays: KioskClosedDays;
}) {
  const { timeZone } = useHints();

  return (
    <div>
      {/* Color key */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
        {rooms.map((room) => (
          <span
            key={room.id}
            className="inline-flex items-center gap-1.5 text-xs text-gray-600"
          >
            <span
              className="inline-block size-3 rounded-sm"
              style={{ backgroundColor: room.color }}
              aria-hidden
            />
            {room.name}
          </span>
        ))}
        {closedDays.enabled ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <span
              className="inline-block size-3 rounded-sm bg-error-200"
              aria-hidden
            />
            Closed
          </span>
        ) : null}
      </div>

      <ClientOnly
        fallback={
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        }
      >
        {() => (
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "dayGridMonth,timeGridWeek",
            }}
            events={[
              ...events,
              ...buildClosedBackgroundEvents(closedDays, timeZone),
            ]}
            height="auto"
            firstDay={1}
            timeZone="local"
            nowIndicator
            eventDisplay="block"
            dayMaxEvents={3}
            eventTimeFormat={{
              hour: "numeric",
              minute: "2-digit",
              meridiem: "short",
            }}
          />
        )}
      </ClientOnly>
    </div>
  );
}
