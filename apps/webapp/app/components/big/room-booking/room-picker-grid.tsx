/**
 * RoomPickerGrid — the image-forward "pick a room to book" card grid.
 *
 * One card per room, led by the room PHOTO (16:9): the image zooms gently on
 * hover, the live {@link RoomStatusChip} floats over it, and the body carries
 * the name, equipment count, description, a 7-day {@link WeekStrip}, and a
 * "Book" call to action. Rooms without a photo get a tasteful color-tinted
 * placeholder so the grid stays even. Shared by the member portal
 * (`/reserve/rooms`) — the caller decides where "Book" links via `bookPath`.
 *
 * Photos come from `Room.imageUrl` (public bucket); recommended size is
 * landscape 16:9 at ≥ 1600 × 900px (see the room edit page).
 *
 * @see {@link file://./../../../routes/_layout+/reserve.rooms._index.tsx} — member picker
 * @see {@link file://./../../rooms/room-photo-upload.tsx} — where admins set the photo
 */
import { DoorOpenIcon } from "lucide-react";
import { Link } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { Button } from "~/components/shared/button";
import { RoomStatusChip } from "./room-status-chip";
import type { ClientRoomSchedule } from "./schedule";
import { WeekStrip } from "./week-strip";

/**
 * A color-tinted placeholder shown when a room has no photo yet — a soft
 * gradient of the room's identity color behind a door icon, so empty cards
 * still read as "a room" and the grid stays visually even.
 *
 * @param props.color - The room's hex identity color (e.g. `#EF6820`)
 */
function RoomImagePlaceholder({ color }: { color: string }) {
  return (
    <div
      className="flex size-full items-center justify-center"
      style={{ background: `linear-gradient(135deg, ${color}1f, ${color}3d)` }}
      aria-hidden
    >
      <DoorOpenIcon className="size-10" style={{ color, opacity: 0.5 }} />
    </div>
  );
}

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
          className="group flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lg"
        >
          {/* Photo header — links into booking; image zooms on hover */}
          <Link
            to={bookPath(room.id)}
            className="relative block aspect-video overflow-hidden"
            aria-label={`Book ${room.name}`}
          >
            {room.imageUrl ? (
              <img
                src={room.imageUrl}
                alt=""
                className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
              />
            ) : (
              <RoomImagePlaceholder color={room.color} />
            )}
            <div className="absolute right-2 top-2">
              <RoomStatusChip
                availability={room.availability}
                className="shadow-sm ring-1 ring-black/5"
              />
            </div>
          </Link>

          <div className="flex flex-1 flex-col gap-3 p-4">
            <div className="flex items-start gap-2">
              <span
                className="mt-1 inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: room.color }}
                aria-hidden
              />
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
