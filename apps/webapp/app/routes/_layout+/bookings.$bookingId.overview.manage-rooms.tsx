/**
 * Manage Rooms modal route (booking overview).
 *
 * Sidebar modal that lets a user reserve/unreserve {@link Room}s on a booking.
 * Rooms are first-class reservable resources: adding a room to a booking also
 * pulls in the room's assigned equipment, and removing it takes that equipment
 * back out — both handled entirely by the booking-rooms service. This route is
 * purely the picker UI + the add/remove diff; it never touches assets directly.
 *
 * It is the room-side mirror of the kit picker
 * ({@link file://./bookings.$bookingId.overview.manage-kits.tsx}), SIMPLIFIED:
 * rooms have no partial check-in, custody, or kit-expansion, so all of that is
 * dropped. The only availability signal surfaced here is "already reserved" —
 * a room already booked in an overlapping time window (computed server-side via
 * {@link createRoomBookingConflictConditions} and rendered as a disabled row).
 *
 * Loader/action gate on the `booking / manageAssets` permission — rooms reuse
 * the assets-manage gate; there is no separate `manageRooms` action. Everything
 * is org-scoped via the `organizationId` returned from `requirePermission`.
 *
 * @see {@link file://./bookings.$bookingId.overview.manage-kits.tsx} — the kit picker this mirrors
 * @see {@link file://../../modules/booking/service.server.ts} — updateBookingRooms / removeBookingRooms
 * @see {@link file://../../modules/room/service.server.ts} — getPaginatedAndFilterableRooms
 */
import { useEffect, useMemo } from "react";
import { RoomStatus, type Prisma } from "@prisma/client";
import { useAtomValue, useSetAtom } from "jotai";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, redirect, Form, useLoaderData } from "react-router";
import { z } from "zod";
import {
  selectedBulkItemsAtom,
  selectedBulkItemsCountAtom,
  setDisabledBulkItemsAtom,
  setSelectedBulkItemAtom,
  setSelectedBulkItemsAtom,
} from "~/atoms/list";
import styles from "~/components/booking/styles.css?url";
import LineBreakText from "~/components/layout/line-break-text";
import { List } from "~/components/list";
import { Filters } from "~/components/list/filters";
import type { ListItemData } from "~/components/list/list-item";
import { RoomBadge } from "~/components/rooms/room-badge";
import { Button } from "~/components/shared/button";
import { GrayBadge } from "~/components/shared/gray-badge";
import { Td, Th } from "~/components/table";
import When from "~/components/when/when";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import {
  getBooking,
  updateBookingRooms,
  removeBookingRooms,
} from "~/modules/booking/service.server";
import { createRoomBookingConflictConditions } from "~/modules/booking/utils.server";
import { getPaginatedAndFilterableRooms } from "~/modules/room/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error, getParams, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const meta = () => [{ title: appendToMetaTitle("Manage rooms") }];

export const links = () => [{ rel: "stylesheet", href: styles }];

/**
 * The room shape rendered by the picker.
 *
 * Beyond the room's own scalar fields we carry:
 *  - `_count.assets` — how many pieces of equipment the room pulls in (shown per row).
 *  - `bookings` — any CONFLICTING bookings in the requested window. This list is
 *    produced by {@link createRoomBookingConflictConditions}; a non-empty array
 *    means the room is already reserved and the row is disabled.
 */
export type RoomForBooking = Prisma.RoomGetPayload<{
  include: {
    _count: { select: { assets: true } };
    bookings: { select: { id: true; status: true; name: true } };
  };
}>;

/**
 * Whether a room is already reserved in the requested window.
 *
 * The loader includes ONLY conflicting bookings on each room (via
 * {@link createRoomBookingConflictConditions}), so any row with bookings is
 * unavailable. Centralised here so the loader (to disable the item) and the row
 * (to render the indicator) agree.
 *
 * @param room - A room carrying its conflicting-bookings list
 * @returns `true` when the room clashes with another booking in the window
 */
function isRoomAlreadyReserved(
  room: Pick<RoomForBooking, "bookings">
): boolean {
  return room.bookings.length > 0;
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }), {
    additionalData: { userId },
  });

  try {
    // Rooms reuse the assets-manage gate — there is no separate manageRooms
    // action. organizationId scopes every read/write below.
    const { organizationId, userOrganizations } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.manageAssets,
    });

    const modelName = {
      singular: "room",
      plural: "rooms",
    };

    // Load the booking to get its from/to window (for conflict detection) and
    // the rooms currently on it (for pre-selection). Only the `rooms` relation
    // needs an explicit extraInclude; scalar from/to come from the base include.
    const booking = await getBooking({
      id: bookingId,
      organizationId,
      userOrganizations,
      request,
      extraInclude: {
        rooms: { select: { id: true } },
      },
    });

    // The IDs of rooms already reserved on this booking, used to pre-select the
    // picker and to diff against the submitted set in the action.
    const bookingRoomIds = booking.rooms.map((room) => room.id);

    const { page, perPage, rooms, search, totalRooms, totalPages } =
      await getPaginatedAndFilterableRooms({
        request,
        organizationId,
        // Attach conflicting bookings to every room so the UI can flag rooms
        // already reserved in this booking's window. The current booking is
        // excluded from conflicts by default, so the rooms already on THIS
        // booking are not flagged as "already reserved".
        extraInclude: {
          bookings: createRoomBookingConflictConditions({
            currentBookingId: bookingId,
            fromDate: booking.from,
            toDate: booking.to,
          }),
        },
      });

    return payload({
      header: {
        title: `Manage rooms for '${booking?.name}'`,
        subHeading:
          "Reserve rooms for this booking. Reserving a room also books its assigned equipment.",
      },
      searchFieldLabel: "Search rooms",
      searchFieldTooltip: {
        title: "Search your rooms",
        text: "Search rooms based on name",
      },
      showSidebar: true,
      noScroll: true,
      booking,
      modelName,
      page,
      perPage,
      totalPages,
      search,
      items: rooms,
      totalItems: totalRooms,
      bookingRoomIds,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, bookingId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }), {
    additionalData: { userId },
  });

  try {
    // Same assets-manage gate as the loader; organizationId scopes all writes.
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.manageAssets,
    });

    // `roomIds` is the FULL desired set of rooms the user wants on the booking
    // after saving. We diff it against the current set below to derive the
    // add/remove operations. Plain string array — rooms have no select-all
    // sentinel handling.
    const { roomIds, redirectTo } = parseData(
      await request.formData(),
      z.object({
        roomIds: z.array(z.string()).optional().default([]),
        redirectTo: z.string().optional().nullable(),
      }),
      { additionalData: { userId, bookingId } }
    );

    // Load the booking's CURRENT room IDs, org-scoped. These are the source of
    // truth we diff the submitted (desired) set against.
    const booking = await db.booking
      .findUniqueOrThrow({
        where: { id: bookingId, organizationId },
        select: {
          id: true,
          rooms: { select: { id: true } },
        },
      })
      .catch((cause) => {
        throw new ShelfError({
          cause,
          label: "Booking",
          message:
            "Booking not found. Are you sure it exists in current workspace?",
        });
      });

    const currentRoomIds = booking.rooms.map((room) => room.id);
    const desiredRoomIds = [...new Set(roomIds)];

    // roomsToAdd = desired − current ; roomsToRemove = current − desired.
    const roomsToAdd = desiredRoomIds.filter(
      (roomId) => !currentRoomIds.includes(roomId)
    );
    const roomsToRemove = currentRoomIds.filter(
      (roomId) => !desiredRoomIds.includes(roomId)
    );

    // Adds the rooms AND pulls in their assigned equipment (service handles it).
    if (roomsToAdd.length > 0) {
      await updateBookingRooms({
        id: bookingId,
        organizationId,
        roomIds: roomsToAdd,
        userId,
      });
    }

    // Removes the rooms AND their assigned equipment (service handles it).
    if (roomsToRemove.length > 0) {
      await removeBookingRooms({
        id: bookingId,
        organizationId,
        roomIds: roomsToRemove,
        userId,
      });
    }

    if (redirectTo) {
      return redirect(redirectTo);
    }

    return redirect(`/bookings/${bookingId}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, bookingId });
    return data(error(reason), { status: reason.status });
  }
}

/**
 * Room picker modal body.
 *
 * Pre-selects the rooms already on the booking, disables rooms that clash with
 * another booking in the window, and submits the full desired set of room IDs.
 * The action derives add/remove from that set.
 *
 * @returns The manage-rooms picker UI
 */
export default function ManageRoomsForBooking() {
  const { items, bookingRoomIds } = useLoaderData<typeof loader>();
  const disabled = useDisabled();

  const selectedBulkItems = useAtomValue(selectedBulkItemsAtom);
  const updateItem = useSetAtom(setSelectedBulkItemAtom);
  const setSelectedBulkItems = useSetAtom(setSelectedBulkItemsAtom);
  const selectedBulkItemsCount = useAtomValue(selectedBulkItemsCountAtom);
  const setDisabledBulkItems = useSetAtom(setDisabledBulkItemsAtom);

  /**
   * Pre-select the rooms already on the booking.
   *
   * Initialized synchronously during the first render (guarded by a ref) rather
   * than in a mount effect, to avoid an empty-first-frame hydration flicker —
   * same approach as the kit picker. `AtomsResetHandler` performs its
   * pathname-change reset during render too, so it runs before this init and
   * does not clobber the selection.
   */
  const didInitializeSelectedItemsRef = useMemo(() => ({ current: false }), []);
  if (!didInitializeSelectedItemsRef.current) {
    didInitializeSelectedItemsRef.current = true;
    setSelectedBulkItems(bookingRoomIds.map((roomId) => ({ id: roomId })));
  }

  /**
   * Disable rooms that are already reserved in this booking's window so they
   * can't be toggled into the selection.
   */
  useEffect(() => {
    const _disabledBulkItems = items.reduce<ListItemData[]>((acc, room) => {
      if (isRoomAlreadyReserved(room as unknown as RoomForBooking)) {
        acc.push(room);
      }
      return acc;
    }, []);

    setDisabledBulkItems(_disabledBulkItems);
  }, [items, setDisabledBulkItems]);

  return (
    <div className="flex h-full max-h-full flex-col">
      <div className="border-b px-6 py-2">
        <GrayBadge className="border border-primary-200 bg-primary-50 text-primary-700">
          {selectedBulkItemsCount} selected
        </GrayBadge>
      </div>

      <Filters
        className="justify-between !border-t-0 border-b px-6 md:flex"
        innerWrapperClassName="justify-between"
      />

      <List
        className="mx-0 mt-0 h-full border-0"
        ItemComponent={Row}
        navigate={(_roomId, room) => {
          // Don't allow selecting a room that's already reserved elsewhere.
          if (isRoomAlreadyReserved(room as RoomForBooking)) {
            return;
          }
          updateItem(room);
        }}
        emptyStateClassName="py-10"
        customEmptyStateContent={{
          title: "You haven't created any rooms yet.",
          text: "Create your first room to start reserving spaces.",
          newButtonRoute: "/rooms/new",
          newButtonContent: "New room",
        }}
        hideFirstHeaderColumn
        bulkActions={<> </>}
        disableSelectAllItems
        headerChildren={
          <>
            <Th></Th>
            <Th>Description</Th>
            <Th>Equipment</Th>
          </>
        }
      />

      {/* Footer of the modal */}
      <footer className="item-center mt-auto flex shrink-0 justify-between border-t px-6 py-3">
        <div className="flex flex-col justify-center gap-1">
          {selectedBulkItems.length} rooms selected
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" to={".."}>
            Close
          </Button>
          <Form method="post">
            {/* The full desired set of room IDs. The action diffs this against
                the booking's current rooms to compute add/remove. */}
            {selectedBulkItems.map((room, i) => (
              <input
                key={room.id}
                type="hidden"
                name={`roomIds[${i}]`}
                value={room.id}
              />
            ))}
            <Button
              type="submit"
              name="intent"
              value="manageRooms"
              disabled={disabled}
            >
              Confirm
            </Button>
          </Form>
        </div>
      </footer>
    </div>
  );
}

/**
 * A single room row in the picker.
 *
 * Shows the {@link RoomBadge}, the room's description, its equipment count, and
 * — when the room clashes with another booking in the window — a small
 * "Already reserved" indicator (the row is also disabled via the loader).
 *
 * @param props.item - The room to render
 * @returns The row cells for one room
 */
function Row({ item: room }: { item: RoomForBooking }) {
  const alreadyReserved = isRoomAlreadyReserved(room);

  return (
    <>
      {/* Name */}
      <Td className="w-full min-w-[330px] whitespace-normal p-0 md:p-0">
        <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
          <div className="flex items-center gap-3">
            <div className="min-w-[130px]">
              <span className="word-break mb-1 block font-medium">
                {room.name}
              </span>
              <div className="flex flex-col items-start gap-2 lg:flex-row lg:items-center">
                <RoomBadge room={room} />
                <When truthy={room.status === RoomStatus.CHECKED_OUT}>
                  <GrayBadge>Checked out</GrayBadge>
                </When>
                <When truthy={alreadyReserved}>
                  <span className="text-xs font-medium text-error-600">
                    Already reserved
                  </span>
                </When>
              </div>
            </div>
          </div>
        </div>
      </Td>

      <Td className="max-w-62 md:max-w-96">
        {room.description ? (
          <LineBreakText
            className="md:max-w-96"
            text={room.description}
            numberOfLines={3}
            charactersPerLine={60}
          />
        ) : null}
      </Td>
      <Td>{room._count.assets}</Td>
    </>
  );
}
