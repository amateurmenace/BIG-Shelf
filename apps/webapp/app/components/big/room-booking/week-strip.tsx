/**
 * WeekStrip — a room's next 7 days at a glance.
 *
 * Seven compact day cells (starting today); each shows the weekday, the day
 * number, and a load bar whose opacity scales with how heavily the day is
 * booked. Anonymized by construction — it only visualizes hours, never names.
 *
 * NOTE: must be rendered inside `<ClientOnly>` (it derives "today" from the
 * viewer's clock/timezone, which would mismatch during SSR hydration).
 *
 * @see {@link file://./schedule.ts} — the math
 */
import { DateTime } from "luxon";
import { useHints } from "~/utils/client-hints";
import { tw } from "~/utils/tw";
import type { ClientBusyWindow } from "./schedule";
import { bookedHoursOnDay, windowsOnDay } from "./schedule";

/**
 * The 7-day strip.
 *
 * @param props.busyWindows - The room's busy windows (from the loader)
 * @param props.color - The room's hex color (used for the load bars)
 * @param props.className - Optional extra classes
 */
export function WeekStrip({
  busyWindows,
  color,
  className,
}: {
  busyWindows: ClientBusyWindow[];
  color: string;
  className?: string;
}) {
  const { timeZone } = useHints();
  const today = DateTime.now().setZone(timeZone).startOf("day");

  const days = Array.from({ length: 7 }, (_, i) => {
    const day = today.plus({ days: i });
    const hours = bookedHoursOnDay(busyWindows, day, timeZone);
    const count = windowsOnDay(busyWindows, day, timeZone).length;
    return { day, hours, count };
  });

  return (
    <div
      className={tw("flex items-end gap-1", className)}
      aria-label="Next 7 days availability"
    >
      {days.map(({ day, hours, count }) => {
        // Load → bar opacity: free days stay light gray; busier days get a
        // denser tint of the room's color. Cap at 8h = "fully booked" look.
        const load = Math.min(hours / 8, 1);
        const title =
          count === 0
            ? `${day.toFormat("EEE d")}: free`
            : `${day.toFormat("EEE d")}: ${count} reservation${
                count === 1 ? "" : "s"
              } (${Math.round(hours * 10) / 10}h)`;

        return (
          <div
            key={day.toISODate()}
            className="flex w-8 flex-col items-center gap-1"
            title={title}
          >
            <span className="text-xs uppercase leading-none text-gray-400">
              {day.toFormat("EEEEE")}
            </span>
            <span
              className={tw(
                "text-xs leading-none",
                day.hasSame(today, "day")
                  ? "font-semibold text-gray-900"
                  : "text-gray-500"
              )}
            >
              {day.day}
            </span>
            <span
              className="h-1.5 w-full rounded-full"
              style={{
                backgroundColor: load === 0 ? "#f2f4f7" : color,
                opacity: load === 0 ? 1 : 0.35 + load * 0.65,
              }}
              aria-hidden
            />
          </div>
        );
      })}
    </div>
  );
}
