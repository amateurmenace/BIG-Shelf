/**
 * Loan items — what the borrower takes away
 *
 * BIG: the equipment AND supplies on a booking, shown on the loan agreement's
 * signing page and on its printed copy. Before this, the agreement listed
 * equipment only (inside the legal text) and supplies not at all, so neither
 * the borrower nor the desk could see everything that was leaving.
 *
 * One component, two looks, so screen and paper can never disagree:
 * - `screen`: compact lists for reading before e-signing;
 * - `print`: tables with Out / Returned tick boxes for the desk to fill in by
 *   hand at pickup and return. Consumables are marked as not coming back.
 *
 * Equipment codes use the shared resolver + badge, like every other asset list.
 *
 * @see {@link file://./../../../modules/big-loan-agreement/service.server.ts} — getLoanItems
 * @see {@link file://./../../../routes/_layout+/loan-agreement.$bookingId.tsx}
 * @see {@link file://./../../../routes/loan-agreement.$bookingId.print.tsx}
 */
import { AssetCodeBadge } from "~/components/assets/asset-code-badge";
import type { LoanItems } from "~/modules/big-loan-agreement/service.server";
import { tw } from "~/utils/tw";

/** An empty box to tick by hand on the printed copy. */
function TickBox() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 rounded-sm border border-gray-500 align-middle"
    />
  );
}

/**
 * @param props.items - The booking's equipment and supplies.
 * @param props.variant - `screen` for the signing page, `print` for paper.
 */
export function LoanItemsList({
  items,
  variant,
}: {
  items: LoanItems;
  variant: "screen" | "print";
}) {
  const { assets, supplies } = items;

  if (variant === "print") {
    return (
      <div className="space-y-4">
        <table className="w-full border-collapse text-sm">
          <caption className="mb-1 text-left text-sm font-semibold text-gray-900">
            Equipment ({assets.length})
          </caption>
          <thead>
            <tr className="border-b border-gray-400 text-left">
              <th scope="col" className="py-1 pr-2 font-medium">
                Item
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Label code
              </th>
              <th scope="col" className="w-16 py-1 text-center font-medium">
                Out
              </th>
              <th scope="col" className="w-20 py-1 text-center font-medium">
                Returned
              </th>
            </tr>
          </thead>
          <tbody>
            {assets.length ? (
              assets.map((asset) => (
                <tr key={asset.id} className="border-b border-gray-200">
                  <td className="py-1.5 pr-2">{asset.title}</td>
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    {asset.code.value}
                  </td>
                  <td className="py-1.5 text-center">
                    <TickBox />
                  </td>
                  <td className="py-1.5 text-center">
                    <TickBox />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="py-1.5 text-gray-600">
                  No equipment on this booking.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {supplies.length ? (
          <table className="w-full border-collapse text-sm">
            <caption className="mb-1 text-left text-sm font-semibold text-gray-900">
              Supplies ({supplies.length})
            </caption>
            <thead>
              <tr className="border-b border-gray-400 text-left">
                <th scope="col" className="w-14 py-1 pr-2 font-medium">
                  Qty
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Item
                </th>
                <th scope="col" className="w-16 py-1 text-center font-medium">
                  Out
                </th>
                <th scope="col" className="w-20 py-1 text-center font-medium">
                  Returned
                </th>
              </tr>
            </thead>
            <tbody>
              {supplies.map((supply) => (
                <tr key={supply.id} className="border-b border-gray-200">
                  <td className="py-1.5 pr-2 tabular-nums">
                    {supply.quantity}
                  </td>
                  <td className="py-1.5 pr-2">{supply.name}</td>
                  <td className="py-1.5 text-center">
                    <TickBox />
                  </td>
                  <td className="py-1.5 text-center text-xs text-gray-600">
                    {/* Consumables are used up, not returned. */}
                    {supply.isConsumable ? "not returned" : <TickBox />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-labelledby="loan-equipment-heading">
        <h3
          id="loan-equipment-heading"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          Equipment ({assets.length})
        </h3>
        {assets.length ? (
          <ul className="divide-y divide-gray-100 rounded border border-gray-200">
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-900"
              >
                <span className="min-w-0 truncate">{asset.title}</span>
                <AssetCodeBadge {...asset.code} className="shrink-0" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">No equipment on this booking.</p>
        )}
      </section>

      <section aria-labelledby="loan-supplies-heading">
        <h3
          id="loan-supplies-heading"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          Supplies ({supplies.length})
        </h3>
        {supplies.length ? (
          <ul className="divide-y divide-gray-100 rounded border border-gray-200">
            {supplies.map((supply) => (
              <li
                key={supply.id}
                className={tw(
                  "flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-900"
                )}
              >
                <span className="min-w-0 truncate">
                  <span className="tabular-nums">{supply.quantity}</span> ×{" "}
                  {supply.name}
                </span>
                {supply.isConsumable ? (
                  <span className="shrink-0 text-xs text-gray-600">
                    consumable
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">No supplies on this booking.</p>
        )}
      </section>
    </div>
  );
}
