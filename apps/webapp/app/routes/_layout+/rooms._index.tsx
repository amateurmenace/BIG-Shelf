/**
 * Rooms Index Route
 *
 * Lists every {@link Room} in the caller's organization in a paginated,
 * searchable table backed by the shared `<List>` component. Rooms are a
 * first-class, reservable entity that holds equipment (assets); each row
 * surfaces the room (as a colored {@link RoomBadge}), its description, and how
 * many assets are assigned to it.
 *
 * The loader gates on `room:read` and shapes the payload for `<List>`
 * (`items`, `page`, `totalItems`, `totalPages`, `perPage`, `modelName`,
 * `search`), plus a per-room live availability map (chip + "Book" button per
 * row — the staff room-booking entry point). The action gates on
 * `room:delete` and resolves the "delete" intent submitted by
 * {@link DeleteRoom} to {@link deleteRoom}.
 *
 * Simplified from the Kits index (`kits._index.tsx`): rooms have no
 * status/custody/QR filters or bulk actions in the MVP.
 *
 * @see {@link file://../../modules/room/service.server.ts} — room business logic
 * @see {@link file://../../components/rooms/room-badge.tsx} — the row badge
 * @see {@link file://../../components/rooms/delete-room.tsx} — the delete dialog
 */

import type { Prisma } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import { RoomStatusChip } from "~/components/big/room-booking/room-status-chip";
import Header from "~/components/layout/header";
import LineBreakText from "~/components/layout/line-break-text";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import { RoomBadge } from "~/components/rooms/room-badge";
import { Button } from "~/components/shared/button";
import { Td, Th } from "~/components/table";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { getRoomsWithSchedule } from "~/modules/big-room-booking/service.server";
import {
  deleteRoom,
  getPaginatedAndFilterableRooms,
} from "~/modules/room/service.server";
import type { ROOMS_INCLUDE_FIELDS } from "~/modules/room/types";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

/** Loader return type, re-exported for typed `useLoaderData`/`useFetcher` consumers. */
export type RoomsIndexLoaderData = typeof loader;

/**
 * Loads a paginated, searchable page of rooms for the current organization.
 *
 * Gated on `room:read`. Shapes the response for the shared `<List>` component
 * and includes each room's assigned-asset count (`_count.assets`) for the
 * "items" column.
 *
 * @param args - Remix loader args (`context` for the session, `request` for
 *   pagination/search params).
 * @returns A `<List>`-shaped payload (`items`, totals, `modelName`, `search`).
 * @throws {ShelfError} If the caller lacks permission or the fetch fails.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.read,
    });

    const { rooms, totalRooms, perPage, page, totalPages, search } =
      await getPaginatedAndFilterableRooms({
        request,
        organizationId,
      });

    if (totalPages !== 0 && page > totalPages) {
      return redirect("/rooms");
    }

    // Live "free / in use until" state per room for the Availability column.
    // Details are not needed here (the chip shows state, not names), so the
    // schedule is loaded anonymized regardless of role.
    const schedules = await getRoomsWithSchedule({
      organizationId,
      horizonDays: 7,
    });
    const availabilityByRoomId = Object.fromEntries(
      schedules.map((room) => [room.id, room.availability])
    );

    const header = {
      title: "Rooms",
    };

    const modelName = {
      singular: "room",
      plural: "rooms",
    };

    return data(
      payload({
        header,
        items: rooms,
        availabilityByRoomId,
        page,
        totalItems: totalRooms,
        totalPages,
        perPage,
        modelName,
        search,
        searchFieldLabel: "Search rooms",
        searchFieldTooltip: {
          title: "Search your rooms",
          text: "Search rooms based on name.",
        },
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Handles row-level mutations on the rooms index.
 *
 * Currently resolves only the "delete" intent submitted by {@link DeleteRoom}
 * — gated on `room:delete` — by org-scoped {@link deleteRoom}. Deleting a room
 * does not delete its assets; the `Asset.roomId` relation is set null.
 *
 * @param args - Remix action args (`context` for the session, `request` for
 *   the submitted form data).
 * @returns A success payload on completion.
 * @throws {ShelfError} If the caller lacks permission or the delete fails.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const formData = await request.formData();

    const { intent, id } = parseData(
      formData,
      z.object({
        intent: z.literal("delete"),
        id: z.string(),
      })
    );

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.delete,
    });

    switch (intent) {
      case "delete": {
        // `id` is org-scoped by `deleteRoom` (organizationId is in the `where`
        // clause), so a raw form-supplied id can never delete another tenant's
        // room even if it exists.
        await deleteRoom({ id, organizationId });

        sendNotification({
          title: "Room deleted",
          message: "Your room has been deleted successfully",
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });

        return payload({ success: true });
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header.title) },
];

export const handle = {
  name: "rooms.index",
};

/**
 * Rooms index page.
 *
 * Renders the page header (with a permission-gated "New room" link button) and
 * the paginated rooms `<List>`. Row rendering is delegated to {@link ListContent}.
 *
 * @returns The rooms index page.
 */
export default function RoomsIndexPage() {
  const { roles } = useUserRoleHelper();
  const canCreateRoom = userHasPermission({
    roles,
    entity: PermissionEntity.room,
    action: PermissionAction.create,
  });

  return (
    <>
      <Header>
        {canCreateRoom && (
          <Button to="new" role="link" aria-label="new room">
            New room
          </Button>
        )}
      </Header>

      <ListContentWrapper>
        <Filters />
        <List
          className="overflow-x-visible md:overflow-x-auto"
          ItemComponent={ListContent}
          customEmptyStateContent={{
            title: "No rooms yet",
            text: "Rooms are reservable spaces that hold equipment. Create a room to start assigning assets to it.",
            newButtonRoute: "/rooms/new",
            newButtonContent: "Create your first room",
          }}
          headerChildren={
            <>
              <Th>Description</Th>
              <Th>Assets</Th>
              <Th>Availability</Th>
              <Th> </Th>
            </>
          }
        />
      </ListContentWrapper>
    </>
  );
}

/**
 * Renders a single room row in the rooms `<List>`.
 *
 * The first cell links to the room's detail page (`/rooms/{id}`) and shows the
 * room as a colored {@link RoomBadge}; the remaining cells show the room's
 * description and its assigned-asset count ("N items").
 *
 * @param props - Component props.
 * @param props.item - The room to render, including its `_count.assets`.
 * @returns The table cells for the room row.
 */
function ListContent({
  item,
}: {
  item: Prisma.RoomGetPayload<{
    include: typeof ROOMS_INCLUDE_FIELDS;
  }>;
}) {
  const { availabilityByRoomId } = useLoaderData<typeof loader>();
  const availability = availabilityByRoomId[item.id];

  return (
    <>
      <Td className="w-full whitespace-normal p-0 md:p-0">
        <Link
          to={`/rooms/${item.id}`}
          className={tw(
            "flex justify-between gap-3 py-4 md:justify-normal md:px-6"
          )}
        >
          <div className="flex items-center gap-3">
            <RoomBadge room={item} />
          </div>
        </Link>
      </Td>

      <Td className="max-w-62 md:max-w-96">
        {item.description ? (
          <LineBreakText
            className="md:max-w-96"
            text={item.description}
            numberOfLines={3}
            charactersPerLine={60}
          />
        ) : null}
      </Td>

      <Td>
        {item._count.assets} {item._count.assets === 1 ? "item" : "items"}
      </Td>

      <Td>
        {availability ? <RoomStatusChip availability={availability} /> : null}
      </Td>

      <Td>
        <Button to={`/rooms/${item.id}/book`} variant="secondary" size="sm">
          Book
        </Button>
      </Td>
    </>
  );
}
