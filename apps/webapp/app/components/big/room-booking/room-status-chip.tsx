/**
 * RoomStatusChip — live "is this room free right now?" pill.
 *
 * Renders a room's availability at a glance: a green "Available" (optionally
 * "free until 3:00 PM") or an amber "In use until 4:30 PM". The state itself
 * is computed server-side (`RoomAvailabilityStatus`), so this component only
 * formats — it never re-derives who booked what.
 *
 * Used on: the member room picker, the staff rooms index, room detail, and
 * the kiosk wallboard.
 *
 * @see {@link file://./../../../modules/big-room-booking/service.server.ts} — where `availability` is computed
 */
import { DateTime } from "luxon";
import { DateS } from "~/components/shared/date";
import { useHints } from "~/utils/client-hints";
import { tw } from "~/utils/tw";
import { toDT } from "./schedule";

/**
 * Formats the "until" instant compactly: time-only when it falls on the same
 * calendar day (in the viewer's timezone), weekday + time otherwise.
 */
function Until({ value }: { value: string | Date }) {
  const { timeZone } = useHints();
  const sameDay = toDT(value, timeZone).hasSame(
    DateTime.now().setZone(timeZone),
    "day"
  );

  return sameDay ? (
    <DateS date={value} onlyTime />
  ) : (
    <DateS
      date={value}
      options={{ weekday: "short", hour: "numeric", minute: "2-digit" }}
    />
  );
}

/**
 * The availability pill.
 *
 * @param props.availability - Server-computed state (`free`/`busy` + `until`)
 * @param props.className - Optional extra classes for sizing/placement
 */
export function RoomStatusChip({
  availability,
  className,
}: {
  availability: { state: "free" | "busy"; until: string | Date | null };
  className?: string;
}) {
  const isFree = availability.state === "free";

  return (
    <span
      className={tw(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        isFree
          ? "bg-success-50 text-success-700"
          : "bg-warning-50 text-warning-700",
        className
      )}
    >
      <span
        className={tw(
          "inline-block size-1.5 rounded-full",
          isFree ? "bg-success-500" : "bg-warning-500"
        )}
        aria-hidden
      />
      {isFree ? (
        availability.until ? (
          <>
            Free until <Until value={availability.until} />
          </>
        ) : (
          "Available"
        )
      ) : availability.until ? (
        <>
          In use until <Until value={availability.until} />
        </>
      ) : (
        "In use"
      )}
    </span>
  );
}
