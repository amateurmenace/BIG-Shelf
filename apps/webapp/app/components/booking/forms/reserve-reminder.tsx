/**
 * "Not reserved yet" reminder
 *
 * BIG: a card pinned to the bottom of the screen on a DRAFT booking that has
 * items in it, with its own Reserve button. The header's Reserve button
 * scrolls out of view as soon as someone scrolls down the equipment list —
 * which is exactly when they have just added things — so people added items
 * and left, believing the gear was held when nothing was.
 *
 * It submits the booking form itself (`form="edit-booking-form"`), so name,
 * dates and "Reserved for" go with it exactly as with the header button, and
 * it is enabled or disabled by the same rule.
 *
 * Same floating style as the member portal's order bar.
 * @see {@link file://./reserve-state.ts}
 * @see {@link file://./../../big/reserve/order-bar.tsx}
 */
import { Button } from "~/components/shared/button";

/**
 * @param props.label - "Reserve", or "Request reservation" for roles that
 *   request rather than reserve.
 * @param props.disabled - From {@link getReserveDisabled}.
 */
export function ReserveReminder({
  label,
  disabled,
}: {
  label: string;
  disabled: false | { reason: string | undefined };
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <section
        aria-label="This booking is not reserved yet"
        className="pointer-events-auto flex w-full max-w-xl items-center justify-between gap-3 rounded-lg border border-warning-300 bg-white p-3 shadow-lg"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">
            Not reserved yet
          </p>
          <p className="text-sm text-gray-600">
            Nothing is held until you click {label}.
          </p>
        </div>
        <Button
          type="submit"
          form="edit-booking-form"
          name="intent"
          value="reserve"
          disabled={disabled}
          className="shrink-0 whitespace-nowrap"
        >
          {label}
        </Button>
      </section>
    </div>
  );
}
