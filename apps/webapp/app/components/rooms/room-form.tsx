/**
 * Room Form
 *
 * Shared create/edit form for the Rooms feature. Rooms are a first-class,
 * reservable entity that holds equipment (assets) and carries a COLOR used for
 * UI highlighting.
 *
 * The form posts to the current route (`method="post"`) — the route's action is
 * responsible for deciding between create and update based on context (e.g. the
 * presence of a room id in the params). Passing current values as props puts the
 * form into "edit" mode; omitting them (all `undefined`) yields "create" mode.
 *
 * Follows the standard Shelf form conventions:
 * - `useZorm` for client-side validation from {@link RoomFormSchema}
 * - server-side validation errors as a fallback (see {@link getValidationErrors})
 * - `useDisabled` to disable the submit button during submission
 * - `ColorInput` for the highlight color, seeded from the server value
 *
 * @see {@link file://./../category/new-category-form.tsx} — the template this mirrors
 * @see {@link file://./../forms/color-input.tsx}
 */

import { useActionData } from "react-router";
import { useZorm } from "react-zorm";
import z from "zod";
import { useDisabled } from "~/hooks/use-disabled";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { zodFieldIsRequired } from "~/utils/zod";
import { ColorInput } from "../forms/color-input";
import Input from "../forms/input";
import { Button } from "../shared/button";

/**
 * Zod schema for the room create/edit form.
 *
 * - `name` — required, at least 2 characters.
 * - `description` — optional free text.
 * - `color` — optional 6-digit hex string (e.g. `#EF6820`). An empty string is
 *   accepted (the ColorInput may submit `""`) and is normalized to `null` so the
 *   service layer clears the stored color rather than persisting an empty value.
 */
export const RoomFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
});

/** Props for {@link RoomForm}. All optional — when omitted the form is in create mode. */
type RoomFormProps = {
  /** Current room name (edit mode). */
  name?: string;
  /** Current room description (edit mode). */
  description?: string | null;
  /** Current room highlight color as a hex string, e.g. `#EF6820` (edit mode). */
  color?: string | null;
};

/**
 * Renders the shared create/edit form for a Room.
 *
 * The form posts to the current route. Client-side validation is driven by
 * {@link RoomFormSchema}; server-side validation errors are surfaced as a
 * fallback so users always see a meaningful message even if client validation
 * is bypassed.
 *
 * @param props - The current room values for edit mode. Omit for create mode.
 * @param props.name - Current room name (edit mode).
 * @param props.description - Current room description (edit mode).
 * @param props.color - Current room highlight color as a hex string (edit mode).
 * @returns The room form element.
 */
export default function RoomForm({ name, description, color }: RoomFormProps) {
  const zo = useZorm("RoomForm", RoomFormSchema);
  const disabled = useDisabled();

  /** This handles server side errors in case client side validation fails. */
  const actionData = useActionData<DataOrErrorResponse>();
  const validationErrors = getValidationErrors<typeof RoomFormSchema>(
    actionData?.error
  );

  return (
    <form ref={zo.ref} method="post" className="flex w-full flex-col gap-4">
      <Input
        label="Name"
        placeholder="Room name"
        name={zo.fields.name()}
        defaultValue={name}
        disabled={disabled}
        error={validationErrors?.name?.message || zo.errors.name()?.message}
        required={zodFieldIsRequired(RoomFormSchema.shape.name)}
      />

      <Input
        label="Description"
        placeholder="Description (optional)"
        inputType="textarea"
        rows={4}
        name={zo.fields.description()}
        defaultValue={description ?? undefined}
        disabled={disabled}
        error={
          validationErrors?.description?.message ||
          zo.errors.description()?.message
        }
        data-test-id="roomDescription"
      />

      <div>
        <ColorInput
          name={zo.fields.color()}
          disabled={disabled}
          error={validationErrors?.color?.message || zo.errors.color()?.message}
          colorFromServer={color ?? undefined}
        />
      </div>

      <div className="flex items-center justify-end gap-1">
        <Button variant="secondary" to=".." size="sm">
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          {disabled ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  );
}
