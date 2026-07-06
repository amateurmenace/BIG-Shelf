/**
 * Room Badge
 *
 * Renders a small colored chip displaying a room's name in the room's own
 * color. Mirrors {@link file://../assets/category-badge.tsx} — it wraps the
 * shared {@link file://../shared/badge.tsx} `<Badge>` primitive, which darkens
 * the supplied color to meet WCAG AA contrast for user-generated colors.
 *
 * Rooms are a first-class, reservable entity; this badge is the shared
 * rendering primitive for surfacing a room across list/detail surfaces.
 *
 * @see {@link file://../shared/badge.tsx}
 * @see {@link file://../assets/category-badge.tsx}
 */
import type { Room } from "@prisma/client";
import { Badge } from "../shared/badge";

/**
 * Displays a room as a colored badge.
 *
 * When the room has a `color`, the badge renders in that color (auto-darkened
 * for contrast by `<Badge>`). When `color` is `null`, it falls back to a
 * neutral gray, matching how {@link CategoryBadge} renders "Uncategorized".
 *
 * @param props - Component props
 * @param props.room - The room to render (only `id`, `name`, and `color` are needed)
 * @param props.className - Optional extra classes forwarded to the badge
 * @returns A colored `<Badge>` element for the room
 */
export function RoomBadge({
  room,
  className,
}: {
  room: Pick<Room, "id" | "name" | "color">;
  className?: string;
}) {
  return room.color ? (
    <Badge color={room.color} withDot={false} className={className}>
      {room.name}
    </Badge>
  ) : (
    <Badge color="#575757" withDot={false} className={className}>
      {room.name}
    </Badge>
  );
}
