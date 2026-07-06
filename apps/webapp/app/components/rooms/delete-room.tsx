/**
 * Delete Room Confirmation Dialog
 *
 * Renders a destructive-action button that, when clicked, opens an
 * {@link AlertDialog} asking the user to confirm deletion of a room. On
 * confirmation it submits a form to the room's detail route with an
 * `intent=delete` and the room `id`, which the rooms index/detail action
 * resolves to {@link deleteRoom}.
 *
 * Deleting a room does not delete its assets — the `Asset.roomId` relation is
 * set null on delete (see `packages/database/prisma/schema.prisma`), so the
 * equipment simply becomes unassigned again.
 *
 * Mirrors the kit deletion dialog at
 * `apps/webapp/app/components/kits/delete-kit.tsx`.
 *
 * @see {@link file://./../../modules/room/service.server.ts}
 */

import type { ReactElement } from "react";
import { cloneElement } from "react";
import type { Room } from "@prisma/client";
import { useDisabled } from "~/hooks/use-disabled";
import { Form } from "../custom-form";
import { TrashIcon } from "../icons/library";
import { Button } from "../shared/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../shared/modal";

/** Props for {@link DeleteRoom}. */
type DeleteRoomProps = {
  /** The room to delete. Only `id` (submitted with the form) and `name` (shown in the dialog copy) are needed. */
  room: Pick<Room, "id" | "name">;
  /**
   * Optional custom trigger element. When provided it replaces the default
   * "Delete" button as the dialog's trigger (e.g. a dropdown menu item).
   */
  trigger?: ReactElement;
};

/**
 * Confirmation dialog + trigger button for deleting a room.
 *
 * Uses {@link useDisabled} to disable the Cancel/Delete buttons while the
 * delete request is in flight, preventing double submissions.
 *
 * @param props - See {@link DeleteRoomProps}.
 * @param props.room - The room being deleted (`id` and `name`).
 * @param props.trigger - Optional element to render as the dialog trigger in
 *   place of the default button.
 * @returns The alert dialog with its trigger.
 */
export function DeleteRoom({ room, trigger }: DeleteRoomProps) {
  const disabled = useDisabled();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {trigger ? (
          cloneElement(trigger)
        ) : (
          <Button
            type="button"
            variant="link"
            icon="trash"
            className="justify-start rounded-sm px-4 py-3 text-sm font-semibold text-gray-700 outline-none  hover:bg-slate-100 hover:text-gray-700"
            width="full"
          >
            Delete
          </Button>
        )}
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mx-auto md:m-0">
            <span className="flex size-12 items-center justify-center rounded-full bg-error-50 p-2 text-error-600">
              <TrashIcon />
            </span>
          </div>
          <AlertDialogTitle>Delete {room.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this room? This action cannot be
            undone. Deleting a room will not delete the assets. Any equipment
            assigned to this room will be made available again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <div className="flex justify-center gap-2">
            <AlertDialogCancel asChild>
              <Button type="button" variant="secondary" disabled={disabled}>
                Cancel
              </Button>
            </AlertDialogCancel>

            <Form method="delete" action={`/rooms/${room.id}`}>
              <input type="hidden" value={room.id} name="id" />
              <input type="hidden" value="delete" name="intent" />
              <Button
                type="submit"
                className="border-error-600 bg-error-600 hover:border-error-800 hover:bg-error-800"
                disabled={disabled}
              >
                Delete
              </Button>
            </Form>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
