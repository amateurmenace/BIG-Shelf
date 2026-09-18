/**
 * Supply Usage report
 *
 * Answers the question the supplies feature exists to answer: *do we own
 * enough cables?*
 *
 * The headline number is **peak concurrent demand**, not total units used.
 * Three bookings that each take four XLR cables in different weeks need four
 * cables between them, not twelve — summing would tell you to buy eight you do
 * not need. The peak is computed with a sweep over the booking windows in
 * {@link getSupplyUsageReport}.
 *
 * @see {@link file://./../big-supply/service.server.ts} — the aggregation
 * @see {@link file://./registry.ts} — where the report is declared
 * @see {@link file://./../../components/reports/supply-usage-content.tsx}
 */
import { getSupplyUsageReport } from "~/modules/big-supply/service.server";
import { SUPPLY_CATEGORY_LABELS } from "~/modules/big-supply/shared";
import { ShelfError } from "~/utils/error";
import type { ChartSeries, ReportPayload, ResolvedTimeframe } from "./types";

/** One row of the Supply Usage table. */
export type SupplyUsageReportRow = {
  supplyId: string;
  supplyName: string;
  category: string;
  /** How many the workspace owns. */
  quantityTotal: number;
  /** Bookings in the timeframe that included this supply. */
  bookingCount: number;
  /** Total units taken across those bookings. */
  unitsUsed: number;
  /** Highest number committed at any one moment. */
  peakConcurrent: number;
  /** `peakConcurrent / quantityTotal` as a percentage. */
  peakUtilization: number;
  /** True when peak demand met or exceeded what is owned. */
  ranOut: boolean;
  isConsumable: boolean;
};

/** Arguments for {@link supplyUsageReport}. */
export interface SupplyUsageArgs {
  organizationId: string;
  timeframe: ResolvedTimeframe;
  page?: number;
  pageSize?: number;
}

/**
 * Builds the Supply Usage report payload.
 *
 * @param args.organizationId - Caller's organization.
 * @param args.timeframe - Resolved reporting window.
 * @param args.page - 1-indexed page.
 * @param args.pageSize - Rows per page.
 * @returns The report payload consumed by `reports.$reportId`.
 * @throws {ShelfError} When the aggregation fails.
 */
export async function supplyUsageReport(
  args: SupplyUsageArgs
): Promise<ReportPayload<SupplyUsageReportRow>> {
  const { organizationId, timeframe, page = 1, pageSize = 50 } = args;
  const startTime = performance.now();

  try {
    const { rows, totals } = await getSupplyUsageReport({
      organizationId,
      from: timeframe.from,
      to: timeframe.to,
    });

    const mapped: SupplyUsageReportRow[] = rows.map((row) => ({
      supplyId: row.supplyId,
      supplyName: row.name,
      category: SUPPLY_CATEGORY_LABELS[row.category],
      quantityTotal: row.quantityTotal,
      bookingCount: row.bookingCount,
      unitsUsed: row.unitsUsed,
      peakConcurrent: row.peakConcurrent,
      peakUtilization: row.peakUtilization,
      // The actionable signal: at some point in this window, demand met or
      // exceeded stock. Those are the lines worth buying more of.
      ranOut: row.quantityTotal > 0 && row.peakConcurrent >= row.quantityTotal,
      isConsumable: row.isConsumable,
    }));

    const stretchedThin = mapped.filter((row) => row.ranOut).length;

    /**
     * Chart: the ten busiest supplies by units used. Ten because the bar chart
     * stops being readable past that, and the tail is rarely interesting.
     */
    const chartSeries: ChartSeries[] = [
      {
        id: "units-used",
        name: "Units used",
        data: mapped.slice(0, 10).map((row) => ({
          // `date` doubles as the category axis key for non-time-series charts.
          date: row.supplyName,
          label: row.supplyName,
          value: row.unitsUsed,
        })),
      },
    ];

    const start = (page - 1) * pageSize;
    const paged = mapped.slice(start, start + pageSize);

    return {
      report: {
        id: "supply-usage",
        title: "Supply Usage",
        description:
          "How hard your cables, batteries and accessories are working — and which ones you keep running out of.",
      },
      filters: { timeframe, filters: [] },
      kpis: [
        {
          id: "units-used",
          label: "Units used",
          value: String(totals.unitsUsed),
          rawValue: totals.unitsUsed,
          format: "number",
          description:
            "Total accessory units taken across every booking in this period.",
        },
        {
          id: "distinct-supplies",
          label: "Supply types used",
          value: String(totals.distinctSupplies),
          rawValue: totals.distinctSupplies,
          format: "number",
        },
        {
          id: "bookings-with-supplies",
          label: "Bookings including supplies",
          value: String(totals.bookingsWithSupplies),
          rawValue: totals.bookingsWithSupplies,
          format: "number",
        },
        {
          id: "stretched-thin",
          label: "Ran out at peak",
          value: String(stretchedThin),
          rawValue: stretchedThin,
          format: "number",
          description:
            "Supplies where demand met or exceeded stock at some point. These are the ones to buy more of.",
        },
      ],
      rows: paged,
      chartSeries,
      computedMs: Math.round(performance.now() - startTime),
      totalRows: mapped.length,
      page,
      pageSize,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      label: "Report",
      message: "Failed to generate Supply Usage report",
      additionalData: { organizationId, timeframe: timeframe.preset },
    });
  }
}
