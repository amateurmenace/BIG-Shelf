/**
 * RoomPhotoUpload — admin control to set / replace / remove a room's photo.
 *
 * Rendered on the room edit page. Posts to that route's action, which branches
 * on content type: a multipart submit (this file input) uploads the photo; the
 * small "Remove photo" form posts `intent=remove-photo`. A live client-side
 * preview shows the chosen file before upload for immediate feedback.
 *
 * The photo is shown to members on the room picker and booking page, so the
 * copy here states the recommended dimensions (landscape 16:9, ≥ 1600×900).
 *
 * @see {@link file://./../../routes/_layout+/rooms.$roomId_.edit.tsx} — the action that handles this
 * @see {@link file://./../../modules/room/service.server.ts} — updateRoomPhotoFromRequest / removeRoomPhoto
 */
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import { Form } from "react-router";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";

/**
 * The photo control.
 *
 * @param props.imageUrl - The room's current photo URL, or null when unset
 * @param props.roomName - The room name (used for the image alt text)
 */
export function RoomPhotoUpload({
  imageUrl,
  roomName,
}: {
  imageUrl: string | null;
  roomName: string;
}) {
  const disabled = useDisabled();
  /** Object-URL preview of a just-chosen file (before it is uploaded). */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const shown = previewUrl ?? imageUrl;

  // Release each blob URL when it's replaced (re-pick) or on unmount, so
  // cycling through candidate photos doesn't leak object URLs.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  /** Show a local preview the instant a file is chosen. */
  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div>
        <span className="block text-sm font-medium text-gray-700">
          Room photo
        </span>
        <p className="text-xs text-gray-500">
          Shown to members on the room picker and booking page. Use a landscape
          16:9 photo, at least 1600 × 900px.
        </p>
      </div>

      <div className="aspect-video w-full max-w-md overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
        {shown ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={shown}
            alt={`${roomName} room photo`}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-gray-400">
            <ImageIcon className="size-8" aria-hidden />
            <span className="text-xs">No photo yet</span>
          </div>
        )}
      </div>

      <Form
        method="post"
        encType="multipart/form-data"
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="file"
          name="image"
          accept="image/*"
          required
          onChange={onFileChange}
          aria-label="Choose a room photo to upload"
          className="block w-full max-w-xs text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
        />
        <Button type="submit" size="sm" disabled={disabled}>
          {disabled
            ? "Uploading…"
            : imageUrl
            ? "Replace photo"
            : "Upload photo"}
        </Button>
      </Form>

      {imageUrl ? (
        <Form method="post">
          <input type="hidden" name="intent" value="remove-photo" />
          <Button
            type="submit"
            variant="secondary"
            size="xs"
            disabled={disabled}
          >
            Remove photo
          </Button>
        </Form>
      ) : null}
    </div>
  );
}
