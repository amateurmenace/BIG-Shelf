/**
 * RoomBookingForm — the shared "book this room" form.
 *
 * One form, three surfaces: the member portal (`/reserve/rooms/:roomId`,
 * custodian fixed to self), the staff page (`/rooms/:roomId/book`, custodian
 * selectable), and — in spirit — the kiosk (which has its own compact form).
 *
 * UX details:
 * - Start/end are controlled `datetime-local` inputs with one-tap duration
 *   presets (+1h / +2h / +4h / all day).
 * - A "that day's schedule" panel updates live as the start date changes, so
 *   pickers see exactly when the room is taken before they submit.
 * - A client-side overlap warning mirrors the server's strict-overlap rule
 *   (`getRoomBookingConflicts`); the server remains the enforcement point.
 * - Server-side validation errors are always displayed (CLAUDE.md form
 *   pattern): per-field via `getValidationErrors`, everything else (e.g. the
 *   409 "room unavailable") in a top-level alert.
 *
 * Field names match `BookingFormSchema` (`name`, `startDate`, `endDate`,
 * `custodian`, `description`) so route actions reuse upstream validation.
 *
 * @see {@link file://./../../../modules/big-room-booking/service.server.ts} — createRoomReservation
 * @see {@link file://./../../booking/forms/forms-schema.ts} — BookingFormSchema
 */
import type { ChangeEvent } from "react";
import { useMemo, useState } from "react";
import { Form, useActionData } from "react-router";
import { MemberPicker } from "~/components/big/member-picker";
import type { BookingFormSchemaType } from "~/components/booking/forms/forms-schema";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import { useHints } from "~/utils/client-hints";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import type { ClientBusyWindow } from "./schedule";
import {
  overlapsAnyWindow,
  toDateTimeLocalValue,
  toDT,
  windowsOnDay,
} from "./schedule";

/** A custodian option for the staff "Reserve for" select. */
export type CustodianOption = {
  id: string;
  name: string;
  userId: string | null;
};

/** Duration presets — one tap sets the end time from the start time. */
const DURATION_PRESETS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "2 hours", hours: 2 },
  { label: "4 hours", hours: 4 },
  { label: "All day", hours: 8 },
];

/**
 * The form.
 *
 * @param props.room - The room being booked (id/name/color for display)
 * @param props.busyWindows - The room's active reservation windows (loader)
 * @param props.defaultStart - Initial start, `datetime-local` format,
 *   computed server-side in the viewer's timezone (hydration-safe)
 * @param props.defaultEnd - Initial end, same format
 * @param props.custodian - Either a fixed custodian (members book as
 *   themselves; rendered as a hidden field) or a select over team members
 *   (staff book on anyone's behalf)
 * @param props.submitLabel - CTA text (default "Reserve room")
 */
export function RoomBookingForm({
  room,
  busyWindows,
  defaultStart,
  defaultEnd,
  custodian,
  submitLabel = "Reserve room",
}: {
  room: { id: string; name: string; color: string };
  busyWindows: ClientBusyWindow[];
  defaultStart: string;
  defaultEnd: string;
  custodian:
    | { kind: "fixed"; value: CustodianOption }
    | { kind: "select"; options: CustodianOption[]; defaultId?: string };
  submitLabel?: string;
}) {
  const { timeZone } = useHints();
  const disabled = useDisabled();
  const actionData = useActionData<DataOrErrorResponse>();

  /** Server-side validation fallback (client validation can be bypassed). */
  const validationErrors = getValidationErrors<BookingFormSchemaType>(
    actionData?.error
  );
  /** Non-field failures (room conflict 409, membership gate, …). */
  const topLevelError =
    actionData?.error && !validationErrors ? actionData.error : null;

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  const startDT = useMemo(
    () => toDT(startDate, timeZone),
    [startDate, timeZone]
  );
  const endDT = useMemo(() => toDT(endDate, timeZone), [endDate, timeZone]);

  /** The selected day's existing reservations, for the schedule panel. */
  const dayWindows = useMemo(
    () => (startDT.isValid ? windowsOnDay(busyWindows, startDT, timeZone) : []),
    [busyWindows, startDT, timeZone]
  );

  const hasOverlap =
    startDT.isValid &&
    endDT.isValid &&
    endDT > startDT &&
    overlapsAnyWindow(busyWindows, startDT, endDT);

  /** Applies a duration preset from the current start time. */
  function applyPreset(hours: number) {
    if (!startDT.isValid) return;
    setEndDate(toDateTimeLocalValue(startDT.plus({ hours })));
  }

  return (
    <Form method="post" className="flex flex-col gap-4">
      {topLevelError ? (
        <div
          role="alert"
          className="rounded border border-error-200 bg-error-50 p-3 text-sm text-error-700"
        >
          <p className="font-medium">
            {topLevelError.title ?? "Couldn't reserve the room"}
          </p>
          <p>{topLevelError.message}</p>
        </div>
      ) : null}

      <Input
        label="Reservation name"
        name="name"
        defaultValue={`${room.name} reservation`}
        required
        error={validationErrors?.name?.message}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Starts"
          type="datetime-local"
          name="startDate"
          value={startDate}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setStartDate(event.currentTarget.value)
          }
          required
          error={validationErrors?.startDate?.message}
        />
        <Input
          label="Ends"
          type="datetime-local"
          name="endDate"
          value={endDate}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setEndDate(event.currentTarget.value)
          }
          required
          error={validationErrors?.endDate?.message}
        />
      </div>

      {/* One-tap durations */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Quick duration:</span>
        {DURATION_PRESETS.map((preset) => (
          <Button
            key={preset.hours}
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => applyPreset(preset.hours)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {/* That day's schedule — updates as the start date changes */}
      <div className="rounded border border-gray-200 bg-gray-25 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {room.name} on{" "}
          {startDT.isValid ? (
            <DateS
              date={startDT.toJSDate()}
              options={{ weekday: "long", month: "short", day: "numeric" }}
            />
          ) : (
            "selected day"
          )}
        </p>
        {dayWindows.length === 0 ? (
          <p className="mt-1.5 text-sm text-success-700">
            Free all day — pick any time.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {dayWindows.map((window) => (
              <li
                key={window.bookingId}
                className="flex items-center gap-2 text-sm text-gray-700"
              >
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: room.color }}
                  aria-hidden
                />
                <span className="tabular-nums">
                  <DateS date={window.from} onlyTime />
                  {" – "}
                  <DateS date={window.to} onlyTime />
                </span>
                {window.bookingName ? (
                  <span className="truncate text-gray-500">
                    · {window.bookingName}
                    {window.custodianName ? ` (${window.custodianName})` : ""}
                  </span>
                ) : (
                  <span className="text-gray-500">· Reserved</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasOverlap ? (
        <div
          role="alert"
          className="rounded border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700"
        >
          Your times overlap an existing reservation above — the booking will be
          rejected. Pick a free slot.
        </div>
      ) : null}

      <Input
        label="Notes (optional)"
        inputType="textarea"
        name="description"
        rows={3}
        placeholder="What's this reservation for?"
        error={validationErrors?.description?.message}
      />

      {custodian.kind === "fixed" ? (
        // Members always book as themselves; the custodian never comes from
        // user input on this surface (and the server re-validates regardless).
        <input
          type="hidden"
          name="custodian"
          value={JSON.stringify(custodian.value)}
        />
      ) : (
        /* BIG: a searchable picker over the WHOLE membership. This was a
           plain <select> listing only people with a Shelf record, which for
           BIG meant staff and almost no members — the ~113 people in the Neon
           directory were unreachable, so staff could not book a room for the
           members the room is for. */
        <MemberPicker
          defaultValue={
            custodian.defaultId
              ? custodian.options.find(
                  (option) => option.id === custodian.defaultId
                ) ?? null
              : null
          }
          disabled={disabled}
          error={validationErrors?.custodian?.message}
          hint="Search anyone by name or email — every BIG member is here, including people who have never logged in."
        />
      )}

      <Button type="submit" disabled={disabled} className="w-full sm:w-auto">
        {disabled ? "Reserving…" : submitLabel}
      </Button>
    </Form>
  );
}
