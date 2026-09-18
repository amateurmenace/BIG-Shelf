/**
 * "Today" KPI row
 *
 * BIG: replaces the old inventory-count KPIs (total assets / categories /
 * locations / team members) at the top of the dashboard. Those numbers were
 * true but inert — nobody opens the dashboard to find out how many categories
 * exist. These four are the ones that change what you do next:
 *
 * - **Out right now** — how much of the collection is not on the shelf
 * - **Collecting today** — the pick list to have ready
 * - **Due back today** — the returns desk
 * - **Overdue** — the only number here that is a problem
 *
 * Overdue is the sole metric coloured by value: red when non-zero, green when
 * clear. The rest are neutral counts, because "12 items out" is neither good
 * nor bad.
 * @see .claude/rules/reports-styling.md
 *
 * @see {@link file://./../../routes/_layout+/home.tsx}
 */
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangleIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  PackageOpenIcon,
} from "lucide-react";
import { Link, useLoaderData } from "react-router";
import type { loader } from "~/routes/_layout+/home";
import { tw } from "~/utils/tw";

/** One tile. */
function Tile({
  label,
  value,
  hint,
  to,
  Icon,
  valueClassName,
}: {
  label: string;
  value: number;
  hint: string;
  to: string;
  Icon: LucideIcon;
  valueClassName?: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300 hover:bg-gray-50 md:p-5"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span
          className={tw(
            "block text-2xl font-semibold tabular-nums",
            valueClassName ?? "text-gray-900"
          )}
        >
          {value.toLocaleString()}
        </span>
        <span className="block text-xs font-medium text-gray-700">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
    </Link>
  );
}

/** Renders the four operational tiles. */
export default function TodayPanel() {
  const {
    assetsOutCount,
    pickingUpTodayCount,
    dueBackTodayCount,
    overdueBookingsCount,
  } = useLoaderData<typeof loader>();

  return (
    <section aria-label="Today at a glance">
      <h2 className="mb-2 text-sm font-semibold text-gray-900">
        Today at a glance
      </h2>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          label="Out right now"
          hint="Items not on the shelf"
          value={assetsOutCount}
          to="/assets?status=CHECKED_OUT"
          Icon={PackageOpenIcon}
        />
        <Tile
          label="Collecting today"
          hint="Reservations to have ready"
          value={pickingUpTodayCount}
          to="/bookings?status=RESERVED"
          Icon={ArrowUpRightIcon}
        />
        <Tile
          label="Due back today"
          hint="Expected at the returns desk"
          value={dueBackTodayCount}
          to="/bookings?status=ONGOING"
          Icon={ArrowDownLeftIcon}
        />
        <Tile
          label="Overdue"
          hint={
            overdueBookingsCount > 0 ? "Needs chasing" : "Nothing outstanding"
          }
          value={overdueBookingsCount}
          to="/bookings?status=OVERDUE"
          Icon={AlertTriangleIcon}
          // The one metric where the value IS the judgement.
          valueClassName={
            overdueBookingsCount > 0 ? "text-red-600" : "text-green-600"
          }
        />
      </div>
    </section>
  );
}
