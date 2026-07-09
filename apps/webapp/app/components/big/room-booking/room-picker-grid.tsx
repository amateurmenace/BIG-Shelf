/**
 * RoomPickerGrid — the "pick a room to book" card grid.
 *
 * One card per room: color accent, name, description, equipment count, a live
 * {@link RoomStatusChip}, a 7-day {@link WeekStrip}, and a "Book" call to
 * action. Shared by the member portal (`/reserve/rooms`) and staff surfaces —
 * the caller decides where "Book" links via `bookPath`.
 *
 * @see {@link file://./../../../routes/_layout+/reserve.rooms._index.tsx} — member picker
 */
import { ClientOnly } from "remix-utils/client-only";
import { Button } from "~/components/shared/button";
import { RoomStatusChip } from "./room-status-chip";
import type { ClientRoomSchedule } from "./schedule";
import { WeekStrip } from "./week-strip";

/**
 * The grid.
 *
 * @param props.rooms - Rooms with schedules (from `getRoomsWithSchedule`)
 * @param props.bookPath - Builds the booking URL for a room id
 */
export function RoomPickerGrid({
  rooms,
  bookPath,
}: {
  rooms: ClientRoomSchedule[];
  bookPath: (roomId: string) => string;
}) {
  if (rooms.length === 0) {
    return (
      <div className="rounded border border-gray-200 bg-white p-6 text-center text-sm text-gray-600">
        No rooms have been set up yet.
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rooms.map((room) => (
        <li
          key={room.id}
          className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
        >
          {/* Color accent bar — the room's identity color, same as its badge */}
          <div
            className="h-1.5 w-full"
            style={{ backgroundColor: room.color }}
            aria-hidden
          />

          <div className="flex flex-1 flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-gray-900">
                  {room.name}
                </h3>
                <p className="text-xs text-gray-500">
                  {room.assetCount > 0
                    ? `Includes ${room.assetCount} piece${
                        room.assetCount === 1 ? "" : "s"
                      } of equipment`
                    : "No equipment attached"}
                </p>
              </div>
              <RoomStatusChip
                availability={room.availability}
                className="shrink-0"
              />
            </div>

            {room.description ? (
              <p className="line-clamp-2 text-sm text-gray-600">
                {room.description}
              </p>
            ) : null}

            <div className="mt-auto flex items-end justify-between gap-3 pt-2">
              {/* Client-only: derives "today" from the viewer's clock */}
              <ClientOnly fallback={<div className="h-10" />}>
                {() => (
                  <WeekStrip
                    busyWindows={room.busyWindows}
                    color={room.color}
                  />
                )}
              </ClientOnly>
              <Button to={bookPath(room.id)} size="sm" className="shrink-0">
                Book
              </Button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
