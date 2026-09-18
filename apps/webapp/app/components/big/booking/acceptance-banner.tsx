/**
 * Booking acceptance banner
 *
 * Shown on the booking page when a reservation was made on someone's behalf.
 *
 * - The person it was made FOR sees Confirm / Decline buttons.
 * - Everyone else (the staff member who made it, other admins) sees the status.
 *
 * The booking holds its equipment either way, so this never blocks anything —
 * it is a courtesy loop, not a gate.
 *
 * @see {@link file://./../../../modules/big-booking-acceptance/service.server.ts}
 */
import { useState } from "react";
import { BookingAcceptanceStatus } from "@prisma/client";
import { CheckCircle2Icon, ClockIcon, XCircleIcon } from "lucide-react";
import { useFetcher, useLoaderData } from "react-router";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import {
  BOOKING_ACCEPTANCE_INTENT,
  DECLINE_NOTE_MAX_LENGTH,
} from "~/modules/big-booking-acceptance/shared";
import type { BookingPageLoaderData } from "~/routes/_layout+/bookings.$bookingId.overview";

/** Per-status presentation: border/background colour, icon and heading. */
const STATUS_PRESENTATION = {
  [BookingAcceptanceStatus.PENDING]: {
    wrapper: "border-warning-300 bg-warning-50",
    Icon: ClockIcon,
    iconClass: "text-warning-600",
  },
  [BookingAcceptanceStatus.ACCEPTED]: {
    wrapper: "border-success-300 bg-success-50",
    Icon: CheckCircle2Icon,
    iconClass: "text-success-600",
  },
  [BookingAcceptanceStatus.DECLINED]: {
    wrapper: "border-error-300 bg-error-50",
    Icon: XCircleIcon,
    iconClass: "text-error-600",
  },
} as const;

/**
 * Renders the acceptance banner, or nothing when the booking was not made on
 * someone else's behalf.
 */
export function BookingAcceptanceBanner() {
  const { bookingAcceptance, userId } = useLoaderData<BookingPageLoaderData>();
  const fetcher = useFetcher();
  const disabled = useDisabled(fetcher);
  const [isDeclining, setIsDeclining] = useState(false);

  if (!bookingAcceptance) return null;

  const { status, requestedByName, requestedForName, responseNote } =
    bookingAcceptance;
  const presentation = STATUS_PRESENTATION[status];
  const { Icon } = presentation;

  /** Only the intended recipient may answer — see the service's 403 guard. */
  const isRecipient = bookingAcceptance.requestedForUserId === userId;
  const isPending = status === BookingAcceptanceStatus.PENDING;

  return (
    <div
      className={`mt-4 rounded-lg border p-4 ${presentation.wrapper}`}
      role="status"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-3">
          <Icon
            className={`mt-0.5 size-5 shrink-0 ${presentation.iconClass}`}
            aria-hidden
          />
          <div>
            {status === BookingAcceptanceStatus.PENDING ? (
              <>
                <p className="text-sm font-semibold text-gray-900">
                  {isRecipient
                    ? "Please confirm this reservation"
                    : "Waiting for confirmation"}
                </p>
                <p className="text-sm text-gray-600">
                  {isRecipient
                    ? `${requestedByName} reserved this for you. The equipment is already being held — confirming just lets the team know you're expecting it.`
                    : `Reserved by ${requestedByName} on behalf of ${
                        requestedForName ?? "someone else"
                      }. They haven't replied yet — the equipment is held regardless.`}
                </p>
              </>
            ) : null}

            {status === BookingAcceptanceStatus.ACCEPTED ? (
              <>
                <p className="text-sm font-semibold text-gray-900">
                  Confirmed by {requestedForName ?? "the recipient"}
                </p>
                <p className="text-sm text-gray-600">
                  Reserved by {requestedByName} on their behalf
                  {bookingAcceptance.respondedAt ? (
                    <>
                      {" "}
                      &middot; confirmed{" "}
                      <DateS date={bookingAcceptance.respondedAt} includeTime />
                    </>
                  ) : null}
                  .
                </p>
              </>
            ) : null}

            {status === BookingAcceptanceStatus.DECLINED ? (
              <>
                <p className="text-sm font-semibold text-gray-900">
                  Declined by {requestedForName ?? "the recipient"}
                </p>
                <p className="text-sm text-gray-600">
                  This booking still holds its equipment. Cancel it to release
                  everything.
                </p>
                {responseNote ? (
                  <p className="mt-2 rounded border border-gray-200 bg-white p-2 text-sm text-gray-700">
                    &ldquo;{responseNote}&rdquo;
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {isPending && isRecipient && !isDeclining ? (
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => setIsDeclining(true)}
            >
              Decline
            </Button>
            <fetcher.Form method="post">
              <input
                type="hidden"
                name="intent"
                value={BOOKING_ACCEPTANCE_INTENT.accept}
              />
              <Button type="submit" disabled={disabled}>
                {disabled ? "Confirming..." : "Confirm"}
              </Button>
            </fetcher.Form>
          </div>
        ) : null}
      </div>

      {isPending && isRecipient && isDeclining ? (
        <fetcher.Form method="post" className="mt-3 border-t pt-3">
          <input
            type="hidden"
            name="intent"
            value={BOOKING_ACCEPTANCE_INTENT.decline}
          />
          <Input
            label="Why are you declining? (optional)"
            name="responseNote"
            placeholder="e.g. I no longer need this for my shoot"
            maxLength={DECLINE_NOTE_MAX_LENGTH}
            className="w-full"
            inputClassName="w-full"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => setIsDeclining(false)}
            >
              Never mind
            </Button>
            <Button type="submit" disabled={disabled}>
              {disabled ? "Sending..." : "Decline reservation"}
            </Button>
          </div>
        </fetcher.Form>
      ) : null}
    </div>
  );
}
