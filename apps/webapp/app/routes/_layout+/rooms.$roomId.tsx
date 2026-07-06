/**
 * Room Detail Route — `/rooms/:roomId`
 *
 * The single-room detail page for the Rooms feature. Rooms are a first-class,
 * reservable entity that holds equipment (assets) and carries a highlight COLOR.
 *
 * Combines the two-file kit detail pattern
 * (`kits.$kitId.tsx` + `kits.$kitId._index.tsx`) into one MVP route:
 * - Loader: resolves the room (org-scoped) with its assigned assets.
 * - Renders: the room name via {@link RoomBadge}, its description, and a simple
 *   list of assigned equipment (asset title → link to `/assets/:id`), plus
 *   Edit / Delete / Manage-equipment actions.
 * - Action: handles the `intent=delete` form submitted by {@link DeleteRoom}.
 * - `<Outlet/>`: mounts child modals such as `/rooms/:roomId/manage-equipment`.
 *
 * Every loader/action is gated with {@link requirePermission} on
 * {@link PermissionEntity.room} and uses the returned `organizationId` for all
 * service calls, enforcing multi-tenant isolation.
 *
 * @see {@link file://./kits.$kitId.tsx} — the detail template this mirrors
 * @see {@link file://../../modules/room/service.server.ts} — the room service
 * @see {@link file://../../components/rooms/delete-room.tsx} — posts the delete intent here
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, Outlet, useLoaderData } from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { DeleteRoom } from "~/components/rooms/delete-room";
import { RoomBadge } from "~/components/rooms/room-badge";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { deleteRoom, getRoom } from "~/modules/room/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { payload, error, getParams, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Route params schema — the room ID comes from the URL and is untrusted input. */
const paramsSchema = z.object({ roomId: z.string() });

/**
 * Loads the room (org-scoped) together with its assigned assets.
 *
 * Gates on {@link PermissionEntity.room} / read and uses the returned
 * `organizationId` so a caller can never read a room from another workspace.
 *
 * @param args - Remix loader args (`context`, `request`, `params`)
 * @returns The room (with its assets) and header data for meta/breadcrumbs
 * @throws {Response} A 4xx/5xx error response produced by {@link makeShelfError}
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.read,
    });

    const room = await getRoom({
      id: roomId,
      organizationId,
      include: {
        // Tight select: the equipment list only needs id + title for the link.
        assets: {
          select: { id: true, title: true },
          orderBy: { title: "asc" },
        },
      },
    });

    const header: HeaderData = {
      title: room.name,
    };

    return payload({ room, header });
  } catch (cause) {
    const reason = makeShelfError(cause, { roomId, userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header?.title) },
];

export const handle = {
  breadcrumb: () => "single",
};

/**
 * Handles mutations posted to the room detail route.
 *
 * Currently only the `delete` intent (submitted by {@link DeleteRoom}). Gates on
 * {@link PermissionEntity.room} / delete and deletes the room via
 * {@link deleteRoom} using the validated `organizationId` — assets assigned to
 * the room are detached by the schema's `onDelete: SetNull`, not here.
 *
 * @param args - Remix action args (`context`, `request`, `params`)
 * @returns A redirect to `/rooms` on success, or an error response on failure
 * @throws {ShelfError} Wrapped by {@link makeShelfError} on any failure
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const formData = await request.formData();
    const { intent } = parseData(
      formData,
      z.object({ intent: z.enum(["delete"]) }),
      { additionalData: { userId, roomId } }
    );

    const intent2ActionMap: { [K in typeof intent]: PermissionAction } = {
      delete: PermissionAction.delete,
    };

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: intent2ActionMap[intent],
    });

    switch (intent) {
      case "delete": {
        await deleteRoom({ id: roomId, organizationId });

        sendNotification({
          title: "Room deleted",
          message: "Your room has been deleted successfully",
          icon: { name: "trash", variant: "error" },
          senderId: userId,
        });

        return redirect("/rooms");
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    return data(error(reason), { status: reason.status });
  }
}

/**
 * Room detail page.
 *
 * Renders the room's name (as a colored {@link RoomBadge}), optional
 * description, a simple list of assigned equipment linking to each asset, and
 * the Edit / Delete / Manage-equipment actions. Renders an `<Outlet/>` so child
 * routes (e.g. the manage-equipment modal) can mount over the page.
 *
 * @returns The room detail layout.
 */
export default function RoomDetails() {
  const { room } = useLoaderData<typeof loader>();

  return (
    <>
      <Header
        title={<RoomBadge room={room} />}
        subHeading={
          <span className="text-sm text-gray-600">
            {room._count.assets} {room._count.assets === 1 ? "asset" : "assets"}
          </span>
        }
      >
        <Button to={`/rooms/${room.id}/edit`} variant="secondary" icon="pen">
          Edit
        </Button>
        <DeleteRoom room={room} />
        <Button
          to={`/rooms/${room.id}/manage-equipment`}
          variant="primary"
          icon="asset"
        >
          Manage equipment
        </Button>
      </Header>

      <div className="mt-4 block md:mx-0 lg:flex">
        {/* Left column — equipment list */}
        <div className="flex-1 md:overflow-hidden">
          <Card className="my-0">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Equipment</h3>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {room._count.assets}
              </span>
            </div>

            {room.assets.length ? (
              <ul className="divide-y divide-gray-100">
                {room.assets.map((asset) => (
                  <li key={asset.id} className="py-2">
                    <Button
                      to={`/assets/${asset.id}`}
                      variant="link"
                      className="text-left font-medium text-gray-900 hover:text-gray-700"
                      target="_blank"
                      onlyNewTabIconOnHover
                    >
                      {asset.title}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">
                No equipment assigned to this room yet.
              </p>
            )}
          </Card>
        </div>

        {/* Right column — room details */}
        <div className="w-full space-y-4 md:w-[360px] lg:ml-4">
          {room.description ? (
            <Card className="my-0">
              <div className="mb-2 text-sm font-semibold text-gray-900">
                Description
              </div>
              <p className="text-sm text-gray-600">{room.description}</p>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Mounts child modals such as /rooms/:roomId/manage-equipment */}
      <Outlet />
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
