/**
 * @file Supply Usage Report Content
 *
 * Renders the body of the "Supply Usage" report: a hero card led by **peak
 * concurrent demand**, a bar chart of the busiest supplies, and a table of
 * every supply used in the period.
 *
 * The design decision worth knowing: the number that matters is not how many
 * units were used in total, it is how many were needed *at once*. Three
 * bookings that each take four XLR cables in different weeks need four cables,
 * not twelve. "Ran out at peak" flags the lines where demand met or exceeded
 * stock — the shopping list.
 *
 * @see {@link file://../../modules/reports/supply-usage.server.ts}
 * @see {@link file://../../modules/big-supply/service.server.ts}
 */

import type { ColumnDef } from "@tanstack/react-table";
import { ReportEmptyState } from "~/components/reports/report-empty-state";
import { ReportTable } from "~/components/reports/report-table";
import { InfoTooltip } from "~/components/shared/info-tooltip";
import type { SupplyUsageReportRow } from "~/modules/reports/supply-usage.server";
import type { ChartSeries, ReportKpi } from "~/modules/reports/types";
import { tw } from "~/utils/tw";
import { BarChart } from "./bar-chart";
import { ChartCard } from "./chart-card";

/**
 * Header for the "Peak at once" column.
 *
 * Hoisted to module scope: TanStack's `flexRender` treats a new function
 * reference as a new component type and remounts the subtree, which makes the
 * Radix tooltip inside churn its ref on every render.
 * @see .claude/rules/react-render-stability.md
 */
function PeakHeader() {
  return (
    <span className="flex items-center gap-1">
      Peak at once
      <InfoTooltip
        iconClassName="size-3.5"
        content={
          <p>
            <strong>Peak concurrent demand</strong> — the most of this supply
            committed at any single moment in the period. This, not the total
            used, is how many you need to own: bookings in different weeks share
            the same cables.
          </p>
        }
      />
    </span>
  );
}

/**
 * Column definitions, at module scope so cell function refs stay stable across
 * renders (see the note on {@link PeakHeader}).
 */
const SUPPLY_USAGE_COLUMNS: ColumnDef<SupplyUsageReportRow>[] = [
  {
    accessorKey: "supplyName",
    header: "Supply",
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-gray-900">
          {row.original.supplyName}
        </div>
        <div className="text-xs text-gray-500">{row.original.category}</div>
      </div>
    ),
  },
  {
    accessorKey: "unitsUsed",
    header: "Units used",
    cell: ({ row }) => (
      <span className="text-sm font-semibold tabular-nums text-gray-900">
        {row.original.unitsUsed}
      </span>
    ),
  },
  {
    accessorKey: "bookingCount",
    header: "Bookings",
    cell: ({ row }) => (
      <span className="text-sm tabular-nums text-gray-600">
        {row.original.bookingCount}
      </span>
    ),
  },
  {
    accessorKey: "peakConcurrent",
    header: PeakHeader,
    cell: ({ row }) => (
      <span
        className={tw(
          "text-sm font-semibold tabular-nums",
          row.original.ranOut ? "text-red-600" : "text-gray-900"
        )}
      >
        {row.original.peakConcurrent}
        <span className="font-normal text-gray-400">
          {" "}
          / {row.original.quantityTotal}
        </span>
      </span>
    ),
  },
  {
    accessorKey: "peakUtilization",
    header: "Peak utilization",
    cell: ({ row }) => (
      // Brand-coloured bar: the WIDTH carries the magnitude. Threshold colours
      // would impose a good/bad judgement the data does not support.
      // @see .claude/rules/reports-styling.md
      <div className="flex items-center gap-2">
        <div className="h-2 w-20 overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-primary-500"
            style={{ width: `${Math.min(row.original.peakUtilization, 100)}%` }}
          />
        </div>
        <span className="text-xs font-semibold tabular-nums text-gray-900">
          {row.original.peakUtilization}%
        </span>
      </div>
    ),
  },
  {
    id: "flag",
    header: "",
    cell: ({ row }) =>
      row.original.ranOut ? (
        <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          Ran out
        </span>
      ) : null,
  },
];

/** Props accepted by {@link SupplyUsageContent}. */
type Props = {
  /** Page of supply rows (already paginated server-side). */
  rows: SupplyUsageReportRow[];
  /** KPI bag from the loader. */
  kpis: ReportKpi[];
  /** Total row count across all pages. */
  totalRows: number;
  /** Human-readable timeframe label, e.g. "Last 30 days". */
  timeframeLabel?: string;
  /** Bar-chart series: the ten busiest supplies. */
  chartSeries?: ChartSeries[];
};

/**
 * Renders the Supply Usage report body.
 *
 * @param props - See {@link Props}.
 */
export function SupplyUsageContent({
  rows,
  kpis,
  totalRows,
  timeframeLabel,
  chartSeries,
}: Props) {
  const unitsUsed =
    (kpis.find((k) => k.id === "units-used")?.rawValue as number) || 0;
  const distinctSupplies =
    (kpis.find((k) => k.id === "distinct-supplies")?.rawValue as number) || 0;
  const bookingsWithSupplies =
    (kpis.find((k) => k.id === "bookings-with-supplies")?.rawValue as number) ||
    0;
  const ranOut =
    (kpis.find((k) => k.id === "stretched-thin")?.rawValue as number) || 0;

  if (rows.length === 0) {
    return (
      <ReportEmptyState
        reason="no_data"
        title="No supplies used in this period"
        description="Once bookings start including cables, batteries and other accessories, this report shows how hard each one is working."
        ctaTo="/settings/supplies"
        ctaLabel="Manage supplies"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Hero */}
      <div className="rounded border border-gray-200 bg-white">
        <div className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-6">
          <div className="flex items-center gap-4">
            <span
              className={tw(
                "text-3xl font-semibold",
                ranOut > 0 ? "text-red-600" : "text-green-600"
              )}
            >
              {ranOut}
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-700">
                {ranOut === 1 ? "supply ran out" : "supplies ran out"}
              </span>
              <span className="text-xs text-gray-500">
                Demand met or exceeded stock at peak
                {timeframeLabel ? ` · ${timeframeLabel}` : ""}
              </span>
            </div>
          </div>

          <div className="flex gap-6 border-t border-gray-100 pt-3 md:border-l md:border-t-0 md:pl-6 md:pt-0">
            <div className="flex flex-col">
              <span className="text-xs text-gray-500">Units used</span>
              <span className="text-lg font-medium tabular-nums text-gray-900">
                {unitsUsed}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-gray-500">Supply types</span>
              <span className="text-lg font-medium tabular-nums text-gray-900">
                {distinctSupplies}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-gray-500">Bookings</span>
              <span className="text-lg font-medium tabular-nums text-gray-900">
                {bookingsWithSupplies}
              </span>
            </div>
          </div>
        </div>
      </div>

      {chartSeries && chartSeries.length > 0 ? (
        <ChartCard title="Busiest supplies">
          <div className="h-64">
            <BarChart
              series={chartSeries}
              layout="vertical"
              radius={4}
              tooltipFormatter={(value) => `${value} units`}
            />
          </div>
        </ChartCard>
      ) : null}

      <div className="rounded border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Every supply used
          </h3>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {totalRows}
          </span>
        </div>
        <ReportTable columns={SUPPLY_USAGE_COLUMNS} data={rows} />
      </div>
    </div>
  );
}
