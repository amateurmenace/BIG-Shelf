/**
 * Create Room Route (`/rooms/new`)
 *
 * Renders the "new room" page and handles its submission. Rooms are a
 * first-class, reservable entity that holds equipment (assets) and carries a
 * COLOR used for UI highlighting.
 *
 * - `loader` gates access with `room:create` permission and returns the page header.
 * - `action` validates the posted form against {@link RoomFormSchema}, creates the
 *   room scoped to the caller's organization, and redirects to the new room's
 *   detail page.
 *
 * Mirrors the create-form conventions in `kits.new.tsx`: org-scoped via
 * `requirePermission`, `try/catch` + `makeShelfError`, and server-side
 * validation errors surfaced back through the shared {@link RoomForm}.
 *
 * @see {@link file://./../../components/rooms/room-form.tsx} — the shared create/edit form + schema
 * @see {@link file://./../../modules/room/service.server.ts} — `createRoom`
 * @see {@link file://./kits.new.tsx} — the template this route mirrors
 */

import { useAtomValue } from "jotai";
import { data, redirect } from "react-router";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { dynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import Header from "~/components/layout/header";
import RoomForm, { RoomFormSchema } from "~/components/rooms/room-form";
import { createRoom } from "~/modules/room/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { assertIsPost, payload, error, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const header = {
  title: "Untitled room",
};

/**
 * Loader for the create-room page.
 *
 * Gates access with `room:create` and returns the static page header.
 *
 * @param args.context - Remix context (source of the auth session)
 * @param args.request - The incoming request
 * @returns The page header payload
 * @throws {Response} A JSON error response if the user lacks permission or on failure
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.create,
    });

    return payload({
      header,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <span>{header.title}</span>,
};

/**
 * Action for the create-room page.
 *
 * Validates the posted form against {@link RoomFormSchema}, creates the room
 * scoped to the caller's (validated) organization, and redirects to the new
 * room's detail page. On failure, returns a JSON error response so the form can
 * surface server-side validation messages as a fallback.
 *
 * @param args.context - Remix context (source of the auth session)
 * @param args.request - The incoming POST request carrying the room form data
 * @returns A redirect to `/rooms/{newRoom.id}` on success, or a JSON error response
 * @throws {ShelfError} Wrapped via `makeShelfError` and returned as an error response
 */
export async function action({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.create,
    });

    const formData = await request.formData();

    const parsedData = parseData(formData, RoomFormSchema);

    const room = await createRoom({
      ...parsedData,
      createdById: userId,
      organizationId,
    });

    sendNotification({
      title: "Room created",
      message: "Your room has been created successfully!",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return redirect(`/rooms/${room.id}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

/**
 * The create-room page component.
 *
 * Renders the page header (reflecting the live, in-progress room name via
 * {@link dynamicTitleAtom}) and the shared {@link RoomForm} in create mode.
 *
 * @returns The create-room page element
 */
export default function CreateNewRoom() {
  const title = useAtomValue(dynamicTitleAtom);

  return (
    <>
      <Header title={title ?? "Untitled room"} />
      <div className="w-full md:max-w-screen-sm">
        <RoomForm />
      </div>
    </>
  );
}
