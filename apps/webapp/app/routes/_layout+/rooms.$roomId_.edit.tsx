/**
 * Edit Room Route
 *
 * Renders and handles the edit form for a single Room. Rooms are a first-class,
 * reservable entity that holds equipment (assets) and carries a COLOR used for
 * UI highlighting.
 *
 * - Loader: gates on `room:update`, loads the org-scoped room, and returns its
 *   current name/description/color to seed the form.
 * - Action: validates the submitted form against {@link RoomFormSchema}, applies
 *   the patch via `updateRoom` (org-scoped), and redirects to the room detail page.
 *
 * Both the loader and action are org-scoped: the `organizationId` used for every
 * service call comes from `requirePermission`, never from the raw route param, so
 * a caller can never read or mutate a room in another tenant.
 *
 * @see {@link file://./../../modules/room/service.server.ts}
 * @see {@link file://./../../components/rooms/room-form.tsx}
 * @see {@link file://./kits.$kitId_.edit.tsx} — the template this mirrors
 */

import { useAtomValue } from "jotai";
import type {
  ActionFunctionArgs,
  MetaFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import { dynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import RoomForm, { RoomFormSchema } from "~/components/rooms/room-form";
import { RoomPhotoUpload } from "~/components/rooms/room-photo-upload";
import { Button } from "~/components/shared/button";
import {
  getRoom,
  removeRoomPhoto,
  updateRoom,
  updateRoomPhotoFromRequest,
} from "~/modules/room/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import {
  assertIsPost,
  payload,
  error,
  getParams,
  parseData,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Loads the room being edited, gated on the `room:update` permission.
 *
 * Uses the `organizationId` returned by `requirePermission` (not the raw param)
 * so the room lookup is scoped to the caller's tenant.
 *
 * @param args - Remix loader args (context, request, params)
 * @returns The room (name/description/color) plus header data for the page
 * @throws {ShelfError} If the user lacks permission or the room does not exist in this org
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { roomId } = getParams(params, z.object({ roomId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.update,
    });

    const room = await getRoom({ id: roomId, organizationId });

    const header: HeaderData = {
      title: `Edit | ${room.name}`,
      subHeading: room.id,
    };

    return payload({ room, header });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => "single",
};

/**
 * Handles submission of the edit-room form.
 *
 * Validates the form against {@link RoomFormSchema}, applies the patch via
 * `updateRoom` (org-scoped by the `organizationId` from `requirePermission`),
 * then redirects to the room detail page.
 *
 * @param args - Remix action args (context, request, params)
 * @returns A redirect to `/rooms/{roomId}` on success
 * @throws {ShelfError} If the request is not a POST, permission is missing,
 *   validation fails, or the update fails
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { roomId } = getParams(params, z.object({ roomId: z.string() }), {
    additionalData: { userId },
  });

  try {
    assertIsPost(request);

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.update,
    });

    // Photo upload posts as multipart — branch BEFORE consuming the body
    // (parseFileFormData reads the stream). It stays on the edit page so the
    // new photo is visible immediately.
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      await updateRoomPhotoFromRequest({ request, roomId, organizationId });
      sendNotification({
        title: "Room photo updated",
        message: "The room photo has been saved.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
      return redirect(`/rooms/${roomId}/edit`);
    }

    const formData = await request.formData();

    // The small "Remove photo" form clears the photo and stays on the edit page.
    if (formData.get("intent") === "remove-photo") {
      await removeRoomPhoto({ roomId, organizationId });
      sendNotification({
        title: "Room photo removed",
        message: "The room photo has been removed.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
      return redirect(`/rooms/${roomId}/edit`);
    }

    const parsedData = parseData(formData, RoomFormSchema, {
      additionalData: { userId, roomId, organizationId },
    });

    await updateRoom({
      id: roomId,
      organizationId,
      ...parsedData,
    });

    sendNotification({
      title: "Room updated",
      message: "Your room has been updated successfully",
      icon: { name: "success", variant: "success" },
      senderId: authSession.userId,
    });

    return redirect(`/rooms/${roomId}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    return data(error(reason), { status: reason.status });
  }
}

/**
 * Edit-room page.
 *
 * Renders the shared {@link RoomForm} seeded with the current room's
 * name/description/color, inside the standard route header.
 *
 * @returns The edit-room page element
 */
export default function RoomEdit() {
  const title = useAtomValue(dynamicTitleAtom);
  const { room } = useLoaderData<typeof loader>();

  return (
    <div className="relative">
      <Header
        title={
          <Button to={`/rooms/${room.id}`} variant={"inherit"}>
            {title !== "" ? title : room.name}
          </Button>
        }
      />

      <div className="flex w-full max-w-screen-sm flex-col gap-8">
        <RoomPhotoUpload imageUrl={room.imageUrl} roomName={room.name} />
        <RoomForm
          name={room.name}
          description={room.description}
          color={room.color}
        />
      </div>
    </div>
  );
}
