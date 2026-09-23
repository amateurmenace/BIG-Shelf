/**
 * When a draft booking's Reserve button can be pressed — and why not.
 *
 * BIG: shared by the Reserve button in the booking header and the floating
 * "Not reserved yet" reminder, so the two can never disagree about whether a
 * booking can be reserved. Extracted verbatim from the header button.
 *
 * @see {@link file://./edit-booking-form.tsx}
 * @see {@link file://./reserve-reminder.tsx}
 */

/** The booking facts that decide whether Reserve is allowed. */
type ReserveFlags = {
  hasAssets?: boolean;
  hasAlreadyBookedAssets?: boolean;
  hasUnavailableAssets?: boolean;
};

/**
 * @param args.disabled - The form is busy or the booking is archived.
 * @param args.isProcessing - A submission is in flight.
 * @param args.isLoadingWorkingHours - Working hours are still loading.
 * @param args.bookingFlags - What the booking contains.
 * @returns `false` when Reserve may be pressed; otherwise the `disabled` value
 *   the shared Button takes, with the reason shown in its tooltip.
 */
export function getReserveDisabled({
  disabled,
  isProcessing,
  isLoadingWorkingHours,
  bookingFlags,
}: {
  disabled: boolean | undefined;
  isProcessing: boolean;
  isLoadingWorkingHours: boolean;
  bookingFlags: ReserveFlags | undefined;
}): false | { reason: string | undefined } {
  const blocked =
    disabled ||
    isLoadingWorkingHours ||
    !bookingFlags?.hasAssets ||
    bookingFlags?.hasAlreadyBookedAssets ||
    bookingFlags?.hasUnavailableAssets;

  if (!blocked) return false;

  return {
    reason: bookingFlags?.hasUnavailableAssets
      ? "You have some assets in your booking that are marked as unavailble. Either remove the assets from this booking or make them available again"
      : bookingFlags?.hasAlreadyBookedAssets
      ? "Your booking has assets that are already booked for the desired period. You need to resolve that before you can reserve"
      : isProcessing || isLoadingWorkingHours
      ? undefined
      : "You need to add assets to your booking before you can reserve it",
  };
}
