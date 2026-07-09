/**
 * BIG Equipment Order — the member's scan-to-reserve cart.
 *
 * A localStorage-persisted Jotai atom so items survive navigating between
 * scans, page reloads, and app re-opens on a phone. Holds a light snapshot
 * (id + title + image) purely for display — the server re-validates every id
 * (org ownership + bookability) at checkout, so a stale snapshot can't
 * reserve anything it shouldn't.
 *
 * NOTE: components reading this atom must render inside `<ClientOnly>` (or
 * otherwise be hydration-safe) — on the server the atom is always `[]`.
 *
 * @see {@link file://./../components/big/reserve/order-bar.tsx}
 * @see {@link file://./../routes/_layout+/reserve.order.tsx} — checkout
 */
import { atomWithStorage } from "jotai/utils";

/** One item in the member's order. */
export type EquipmentOrderItem = {
  id: string;
  title: string;
  /** Thumbnail/main image URL snapshot, or null when the asset has none. */
  image: string | null;
};

/** The cart. Persisted per-browser under this key. */
export const equipmentOrderAtom = atomWithStorage<EquipmentOrderItem[]>(
  "big-equipment-order",
  []
);
