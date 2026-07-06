/**
 * Room Module Types
 *
 * Shared types and Prisma include/select constants for the Room service.
 * Rooms are a first-class, reservable entity that can hold equipment (assets),
 * mirroring how Kits and Locations work. This file keeps the payload shapes and
 * include fragments in one place so the service and its future route/component
 * consumers stay in sync.
 *
 * @see {@link file://./service.server.ts} — the service functions that consume these types
 */

import type { Prisma, Room } from "@prisma/client";

/**
 * Payload accepted by `updateRoom`.
 *
 * `id` and `organizationId` are always required (they org-scope the update).
 * Every other field is optional so callers can patch individual attributes
 * without clobbering the rest of the record.
 */
export type UpdateRoomPayload = Partial<
  Pick<Room, "name" | "description" | "color" | "status">
> & {
  id: Room["id"];
  organizationId: Room["organizationId"];
};

/**
 * Static includes always returned by `getRoom`.
 *
 * Kept intentionally lean for the MVP — a room count of its assigned assets is
 * useful on nearly every surface (index rows, detail header), so it is always
 * fetched. Callers needing the full asset list pass `extraInclude` instead.
 */
export const GET_ROOM_STATIC_INCLUDES = {
  _count: { select: { assets: true } },
} satisfies Prisma.RoomInclude;

/**
 * Include fields merged into every row of `getPaginatedAndFilterableRooms`.
 *
 * Only the asset count is needed for list rows; heavier relations are opt-in
 * via `extraInclude` to avoid payload bloat on the index.
 */
export const ROOMS_INCLUDE_FIELDS = {
  _count: { select: { assets: true } },
} satisfies Prisma.RoomInclude;
