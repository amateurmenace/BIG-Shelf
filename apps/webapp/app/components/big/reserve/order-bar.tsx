/**
 * OrderBar — the floating "your order" bar for the member portal.
 *
 * Shows on every portal page while the scan-to-reserve cart has items: a
 * fixed, thumb-reachable bottom bar (mobile-first) with the item count and a
 * "Review & reserve" call to action into the checkout page. Hidden on the
 * checkout page itself (it would duplicate the page's own submit).
 *
 * Wrapped in `<ClientOnly>` internally — the cart lives in localStorage, so
 * SSR always sees an empty cart.
 *
 * @see {@link file://./../../../atoms/big-equipment-order.ts}
 * @see {@link file://./../../../routes/_layout+/reserve.order.tsx}
 */
import { useAtomValue } from "jotai";
import { ShoppingBagIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { equipmentOrderAtom } from "~/atoms/big-equipment-order";

/** The bar (client-only inner so hydration never mismatches). */
function OrderBarInner() {
  const order = useAtomValue(equipmentOrderAtom);
  const location = useLocation();

  // Hidden on checkout (its own submit) and on the scanner (its own sticky
  // footer CTA — the floating bar would cover the scan log).
  if (
    order.length === 0 ||
    ["/reserve/order", "/reserve/scan"].includes(location.pathname)
  ) {
    return null;
  }

  /**
   * BIG: `?addTo=<bookingId>` means the member is adding gear to a reservation
   * they already have (e.g. the room they just booked). Carry it through to
   * checkout so the order joins that booking instead of creating a second one.
   */
  const addTo = new URLSearchParams(location.search).get("addTo");
  const checkoutTo = addTo
    ? `/reserve/order?addTo=${encodeURIComponent(addTo)}`
    : "/reserve/order";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <Link
        to={checkoutTo}
        className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-full bg-gray-900 px-5 py-3 text-white shadow-xl transition hover:bg-gray-800"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <ShoppingBagIcon className="size-4" aria-hidden />
          {order.length} item{order.length === 1 ? "" : "s"} in your order
        </span>
        <span className="text-sm font-semibold text-primary-300">
          Review &amp; reserve →
        </span>
      </Link>
    </div>
  );
}

/** Mount once in the member portal layout. */
export function OrderBar() {
  return <ClientOnly fallback={null}>{() => <OrderBarInner />}</ClientOnly>;
}
