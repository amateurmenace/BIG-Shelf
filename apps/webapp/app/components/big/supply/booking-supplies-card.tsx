/**
 * Booking supplies card
 *
 * The list of pooled supplies attached to a booking, shown on the booking page
 * under the equipment list, with the entry point to the supply wizard.
 *
 * Renders as a compact card rather than a full table: supplies are a short
 * checklist ("2 × 25ft XLR, 1 × LP-E6, 4 × 8ft HDMI"), not a data grid.
 *
 * @see {@link file://./supply-wizard.tsx}
 * @see {@link file://./../../../modules/big-supply/service.server.ts}
 */
import { PackagePlusIcon } from "lucide-react";
import { useLoaderData } from "react-router";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import type { BookingSupplyLine } from "~/modules/big-supply/service.server";
import { SUPPLY_CATEGORY_LABELS } from "~/modules/big-supply/shared";
import type { BookingPageLoaderData } from "~/routes/_layout+/bookings.$bookingId.overview";

export function BookingSuppliesCard({
  /** Disabled for bookings whose contents can no longer change. */
  canManage,
}: {
  canManage: boolean;
}) {
  const { bookingSupplies } = useLoaderData<BookingPageLoaderData>();
  const lines: BookingSupplyLine[] = bookingSupplies ?? [];

  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <Card className="my-0 mt-4 p-0">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Supplies &amp; accessories
          </h3>
          <p className="text-xs text-gray-500">
            Cables, batteries and adapters — counted, not individually tracked
          </p>
        </div>
        <div className="flex items-center gap-2">
          {totalUnits > 0 ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium tabular-nums text-gray-600">
              {totalUnits}
            </span>
          ) : null}
          {canManage ? (
            <Button
              to="manage-supplies"
              variant="secondary"
              className="whitespace-nowrap"
            >
              <span className="flex items-center gap-1.5">
                <PackagePlusIcon className="size-4" aria-hidden />
                {lines.length > 0 ? "Edit supplies" : "Add supplies"}
              </span>
            </Button>
          ) : null}
        </div>
      </div>

      {lines.length === 0 ? (
        <p className="p-4 text-sm text-gray-600 md:px-6">
          No supplies on this booking yet
          {canManage
            ? " — use “Add supplies” to grab cables, batteries and the rest in one pass."
            : "."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex items-center justify-between gap-4 px-4 py-2.5 md:px-6"
            >
              <span className="min-w-0 truncate text-sm text-gray-900">
                <span className="font-semibold tabular-nums">
                  {line.quantity} ×
                </span>{" "}
                {line.name}
                {line.isConsumable ? (
                  <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600">
                    Consumable
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-gray-500">
                {line.storageLocation ?? SUPPLY_CATEGORY_LABELS[line.category]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
