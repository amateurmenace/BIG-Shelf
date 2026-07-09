/**
 * ExpandableRoomCalendar — the member dashboard's availability widget.
 *
 * Collapsed: a compact card with one 7-day {@link WeekStrip} per room — a
 * glance answers "is anything free this week?".
 * Expanded: a full-screen dialog with a FullCalendar month/week view of every
 * room's reservations.
 *
 * PRIVACY: events arrive pre-anonymized from `getRoomAvailability` (titles
 * are room names; no booking or member names ever reach this component).
 *
 * @see {@link file://./../../../modules/big-member/service.server.ts} — getRoomAvailability
 * @see {@link file://./../../../routes/_layout+/reserve._index.tsx} — the dashboard
 */
import { useEffect, useRef, useState } from "react";
import dayGridPlugin from "@fullcalendar/daygrid";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { XIcon } from "lucide-react";
import { ClientOnly } from "remix-utils/client-only";
import { Button } from "~/components/shared/button";
import { Spinner } from "~/components/shared/spinner";
import type { ClientRoomSchedule } from "./schedule";
import { WeekStrip } from "./week-strip";

/** A pre-anonymized calendar event (see `RoomAvailabilityEvent`). */
type RoomEvent = {
  id: string;
  title: string;
  start: string | Date;
  end: string | Date;
  backgroundColor: string;
  borderColor: string;
};

/**
 * The widget.
 *
 * @param props.rooms - Rooms with schedules, for the compact week strips
 * @param props.events - Anonymized reservation events for the full calendar
 */
export function ExpandableRoomCalendar({
  rooms,
  events,
}: {
  rooms: ClientRoomSchedule[];
  events: RoomEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Dialog plumbing: focus the close button on open (imperative focus per
  // house a11y rule — no autoFocus prop), close on Escape, lock page scroll.
  useEffect(() => {
    if (!expanded) return;

    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  if (rooms.length === 0) {
    return (
      <p className="text-sm text-gray-600">No rooms have been set up yet.</p>
    );
  }

  return (
    <>
      {/* Collapsed: one week strip per room */}
      <ul className="divide-y divide-gray-100">
        {rooms.map((room) => (
          <li
            key={room.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <span
                className="inline-block size-3 shrink-0 rounded-sm"
                style={{ backgroundColor: room.color }}
                aria-hidden
              />
              <span className="truncate text-sm font-medium text-gray-900">
                {room.name}
              </span>
            </span>
            <ClientOnly fallback={<div className="h-10 w-60" />}>
              {() => (
                <WeekStrip busyWindows={room.busyWindows} color={room.color} />
              )}
            </ClientOnly>
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setExpanded(true)}
        >
          Open full calendar
        </Button>
      </div>

      {/* Expanded: full-screen month/week calendar */}
      {expanded ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 md:p-8"
          role="presentation"
          onClick={(event) => {
            // Backdrop click closes; clicks inside the panel don't bubble here.
            if (event.target === event.currentTarget) {
              setExpanded(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Room availability calendar"
            className="flex max-h-full w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Room availability
                </h2>
                <p className="text-xs text-gray-500">
                  Colored blocks show when a room is reserved — open slots are
                  free to book.
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Close calendar"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            {/* Color key */}
            <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-gray-100 px-4 py-2 md:px-6">
              {rooms.map((room) => (
                <span
                  key={room.id}
                  className="inline-flex items-center gap-1.5 text-xs text-gray-600"
                >
                  <span
                    className="inline-block size-3 rounded-sm"
                    style={{ backgroundColor: room.color }}
                  />
                  {room.name}
                </span>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
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
                    events={events}
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
          </div>
        </div>
      ) : null}
    </>
  );
}
