/**
 * Room Service
 *
 * Business-logic layer for the Room entity. Rooms are a first-class, reservable
 * resource that can hold equipment (assets), mirroring how Kits and Locations
 * work. Every function is org-scoped: `organizationId` is a required typed
 * parameter so the compiler forces callers to supply it, and all reads/writes
 * are filtered by it to enforce multi-tenant isolation.
 *
 * This is a lean MVP: no custody, QR/barcode, image handling, or bulk
 * operations. Those can be layered on later following the Kit service patterns.
 *
 * @see {@link file://./types.ts} — shared payload types and include constants
 * @see {@link file://../kit/service.server.ts} — the fuller Kit service these functions mirror
 * @see {@link file://../location/service.server.ts} — `updateLocationAssets`, the model for `updateRoomAssets`
 */

import type { Asset, Organization, Prisma, Room, User } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { db } from "~/database/db.server";
import { updateCookieWithPerPage } from "~/utils/cookies.server";
import type { ErrorLabel } from "~/utils/error";
import {
  isLikeShelfError,
  isNotFoundError,
  maybeUniqueConstraintViolation,
  ShelfError,
} from "~/utils/error";
import { getCurrentSearchParams } from "~/utils/http.server";
import { ALL_SELECTED_KEY, getParamsValues } from "~/utils/list";
import { assertAssetsBelongToOrg } from "~/utils/org-validation.server";
import type { MergeInclude } from "~/utils/utils";
import { GET_ROOM_STATIC_INCLUDES, ROOMS_INCLUDE_FIELDS } from "./types";
import type { UpdateRoomPayload } from "./types";
import { getAssetsWhereInput } from "../asset/utils.server";

const label: ErrorLabel = "Room";

/**
 * Creates a new Room within an organization.
 *
 * @param params.name - Display name of the room
 * @param params.description - Optional free-text description
 * @param params.color - Optional hex color (e.g. "#EF6820") for the room badge
 * @param params.createdById - ID of the user creating the room
 * @param params.organizationId - The caller's (validated) organization ID
 * @returns The created Room record
 * @throws {ShelfError} If the database operation fails (e.g. unique constraint)
 */
export async function createRoom({
  name,
  description,
  color,
  createdById,
  organizationId,
}: Pick<Room, "name" | "organizationId" | "createdById"> & {
  description?: Room["description"];
  color?: Room["color"];
}) {
  try {
    const data: Prisma.RoomCreateInput = {
      name,
      description,
      color,
      createdBy: { connect: { id: createdById } },
      organization: { connect: { id: organizationId } },
    };

    return await db.room.create({ data });
  } catch (cause) {
    throw maybeUniqueConstraintViolation(cause, "Room", {
      additionalData: { userId: createdById, organizationId },
    });
  }
}

/** Resolves the payload shape of `getRoom` based on the optional `include`. */
type RoomWithInclude<T extends Prisma.RoomInclude | undefined> =
  T extends Prisma.RoomInclude
    ? Prisma.RoomGetPayload<{
        include: MergeInclude<typeof GET_ROOM_STATIC_INCLUDES, T>;
      }>
    : Prisma.RoomGetPayload<{ include: typeof GET_ROOM_STATIC_INCLUDES }>;

/**
 * Fetches a single Room by ID, scoped to the caller's organization.
 *
 * Merges the caller-supplied `include` on top of {@link GET_ROOM_STATIC_INCLUDES}
 * so every room carries its asset count plus whatever extra relations the
 * caller asked for.
 *
 * @param params.id - The room ID (from request/route input)
 * @param params.organizationId - The caller's (validated) organization ID
 * @param params.include - Optional extra Prisma includes merged over the static ones
 * @returns The matching Room, typed with the merged includes
 * @throws {ShelfError} 404-flavored error if the room does not exist in this org
 */
export async function getRoom<T extends Prisma.RoomInclude | undefined>({
  id,
  organizationId,
  include,
}: Pick<Room, "id" | "organizationId"> & {
  include?: T;
}) {
  try {
    const includes = {
      ...GET_ROOM_STATIC_INCLUDES,
      ...include,
    } as MergeInclude<typeof GET_ROOM_STATIC_INCLUDES, T>;

    const room = await db.room.findFirstOrThrow({
      where: { id, organizationId },
      include: includes,
    });

    return room as RoomWithInclude<T>;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      title: "Room not found",
      message:
        "The room you are trying to access does not exist or you do not have permission to access it.",
      additionalData: {
        id,
        organizationId,
        ...(isShelfError ? cause.additionalData : {}),
      },
      label,
      shouldBeCaptured: isShelfError
        ? cause.shouldBeCaptured
        : !isNotFoundError(cause),
    });
  }
}

/**
 * Returns a paginated, name-searchable list of Rooms for an organization.
 *
 * Mirrors the Kit index pagination/search but drops kit-specific status and
 * custodian filters — the MVP only needs a simple `name` search plus paging and
 * a total count. Callers can widen the returned shape via `extraInclude`.
 *
 * @param params.request - The incoming request (source of search params + per-page cookie)
 * @param params.organizationId - The caller's (validated) organization ID
 * @param params.extraInclude - Optional extra Prisma includes merged over {@link ROOMS_INCLUDE_FIELDS}
 * @returns Pagination metadata plus the matching rooms
 * @throws {ShelfError} If the database operation fails
 */
export async function getPaginatedAndFilterableRooms<
  T extends Prisma.RoomInclude,
>({
  request,
  organizationId,
  extraInclude,
}: {
  request: LoaderFunctionArgs["request"];
  organizationId: Organization["id"];
  extraInclude?: T;
}) {
  const searchParams = getCurrentSearchParams(request);
  const { page, perPageParam, search } = getParamsValues(searchParams);

  const cookie = await updateCookieWithPerPage(request, perPageParam);
  const { perPage } = cookie;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 && perPage <= 100 ? perPage : 200;

    const where: Prisma.RoomWhereInput = { organizationId };

    if (search) {
      const searchTerm = search.toLowerCase().trim();
      where.name = { contains: searchTerm, mode: "insensitive" };
    }

    const include = {
      ...extraInclude,
      ...ROOMS_INCLUDE_FIELDS,
    } as MergeInclude<typeof ROOMS_INCLUDE_FIELDS, T>;

    const [rooms, totalRooms] = await Promise.all([
      db.room.findMany({
        skip,
        take,
        where,
        include,
        orderBy: { createdAt: "desc" },
      }),
      db.room.count({ where }),
    ]);

    const totalPages = Math.ceil(totalRooms / perPage);

    return {
      page,
      perPage,
      rooms,
      totalRooms,
      totalPages,
      search,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching rooms",
      additionalData: { page, perPage, organizationId },
      label,
    });
  }
}

/**
 * Updates an existing Room, scoped to the caller's organization.
 *
 * Only the fields present in the payload are written. The `where` clause
 * includes `organizationId` so a caller can never update a room in another
 * tenant, even with a valid-looking foreign ID.
 *
 * @param params - {@link UpdateRoomPayload}: `id` + `organizationId` plus optional patch fields
 * @returns The updated Room record
 * @throws {ShelfError} If the database operation fails (e.g. unique constraint)
 */
export async function updateRoom({
  id,
  organizationId,
  name,
  description,
  color,
  status,
}: UpdateRoomPayload) {
  try {
    const data: Prisma.RoomUpdateInput = {
      name,
      description,
      color,
      status,
    };

    return await db.room.update({
      where: { id, organizationId },
      data,
    });
  } catch (cause) {
    throw maybeUniqueConstraintViolation(cause, "Room", {
      additionalData: { id, organizationId },
    });
  }
}

/**
 * Deletes a Room, scoped to the caller's organization.
 *
 * Assets assigned to the room are detached via the schema's `onDelete: SetNull`
 * on `Asset.roomId` — this function does not need to unassign them explicitly.
 *
 * @param params.id - The room ID (from request/route input)
 * @param params.organizationId - The caller's (validated) organization ID
 * @returns The deleted Room record
 * @throws {ShelfError} If the room does not exist in this org or deletion fails
 */
export async function deleteRoom({
  id,
  organizationId,
}: Pick<Room, "id" | "organizationId">) {
  try {
    return await db.room.delete({ where: { id, organizationId } });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while deleting room",
      additionalData: { id, organizationId },
      label,
    });
  }
}

/**
 * Assigns and/or removes equipment (assets) on a Room.
 *
 * Mirrors `updateLocationAssets` (lean MVP variant): given the full desired set
 * of `assetIds`, it computes which assets to connect (not yet in the room) and
 * which to disconnect (currently in the room but no longer desired), then
 * applies both inside a single transaction.
 *
 * Supports the ALL_SELECTED_KEY "select all" pattern: when the sentinel is
 * present, the desired set is resolved from the current search-param filters.
 *
 * SECURITY: every incoming asset ID is proven to belong to `organizationId`
 * (via the shared {@link assertAssetsBelongToOrg} guard, inside the tx) before
 * any `connect`/`disconnect`. Without this, Prisma's 1:N relation writes accept
 * cross-org IDs and would silently reparent another workspace's asset
 * (cross-org IDOR / CWE-862).
 *
 * @param params.roomId - The target room ID (from request/route input)
 * @param params.organizationId - The caller's (validated) organization ID
 * @param params.assetIds - The full desired set of asset IDs for the room (or `[ALL_SELECTED_KEY]`)
 * @param params.userId - ID of the acting user (reserved for future audit notes)
 * @param params.request - The incoming request (source of filters for select-all)
 * @returns The updated Room record
 * @throws {ShelfError} If the room is missing, an asset is cross-org, or the write fails
 */
export async function updateRoomAssets({
  roomId,
  organizationId,
  assetIds,
  userId,
  request,
}: {
  roomId: Room["id"];
  organizationId: Room["organizationId"];
  assetIds: Asset["id"][];
  userId: User["id"];
  request: Request;
}) {
  try {
    const room = await db.room
      .findUniqueOrThrow({
        where: { id: roomId, organizationId },
        include: { assets: { select: { id: true } } },
      })
      .catch((cause) => {
        // Only a genuine "record not found" becomes a user-facing 404; re-throw
        // anything else so the outer catch wraps it as a capturable 5xx.
        if (isNotFoundError(cause)) {
          throw new ShelfError({
            cause,
            message: "Room not found",
            additionalData: { roomId, userId, organizationId },
            status: 404,
            label,
            shouldBeCaptured: false,
          });
        }
        throw cause;
      });

    /**
     * If the user selected all assets, expand the sentinel into the concrete
     * set of asset IDs matching the currently-applied filters.
     */
    let desiredAssetIds = assetIds;
    if (assetIds.includes(ALL_SELECTED_KEY)) {
      const searchParams = getCurrentSearchParams(request);
      const assetsWhere = getAssetsWhereInput({
        organizationId,
        currentSearchParams: searchParams.toString(),
      });

      const allAssets = await db.asset.findMany({
        where: assetsWhere,
        select: { id: true },
      });

      desiredAssetIds = allAssets.map((asset) => asset.id);
    }

    /** Compute the connect/disconnect deltas against the room's current assets. */
    const currentAssetIds = new Set(room.assets.map((asset) => asset.id));
    const desiredSet = new Set(desiredAssetIds);

    const assetIdsToConnect = [...desiredSet].filter(
      (id) => !currentAssetIds.has(id)
    );
    const assetIdsToDisconnect = [...currentAssetIds].filter(
      (id) => !desiredSet.has(id)
    );

    await db.$transaction(async (tx) => {
      /**
       * SECURITY: prove every asset we are about to connect belongs to this
       * org before the write. Disconnect targets are already known to be in
       * the room (hence in-org), so only the connect set needs validation.
       */
      await assertAssetsBelongToOrg(
        { assetIds: assetIdsToConnect, organizationId },
        tx
      );

      if (assetIdsToConnect.length > 0) {
        await tx.room.update({
          where: { id: roomId, organizationId },
          data: {
            assets: { connect: assetIdsToConnect.map((id) => ({ id })) },
          },
        });
      }

      if (assetIdsToDisconnect.length > 0) {
        await tx.room.update({
          where: { id: roomId, organizationId },
          data: {
            assets: { disconnect: assetIdsToDisconnect.map((id) => ({ id })) },
          },
        });
      }
    });

    return room;
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating the room assets.",
      additionalData: { roomId, organizationId },
      label,
    });
  }
}
