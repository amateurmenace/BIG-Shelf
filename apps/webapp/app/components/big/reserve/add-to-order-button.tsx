/**
 * AddToOrderButton — toggles an asset in the member's scan-to-reserve order.
 *
 * Purely client-side (writes the persisted cart atom); the server re-validates
 * every item at checkout. Renders "Add to order" or "Remove from order"
 * depending on membership in the cart.
 *
 * NOTE: render inside `<ClientOnly>` — the cart lives in localStorage.
 *
 * @see {@link file://./../../../atoms/big-equipment-order.ts}
 */
import { useAtom } from "jotai";
import { CheckIcon, PlusIcon } from "lucide-react";
import type { EquipmentOrderItem } from "~/atoms/big-equipment-order";
import { equipmentOrderAtom } from "~/atoms/big-equipment-order";
import { Button } from "~/components/shared/button";
import { tw } from "~/utils/tw";

/**
 * The toggle button.
 *
 * @param props.item - The asset snapshot to add (id/title/image)
 * @param props.size - Button size (defaults to "sm")
 * @param props.className - Extra classes (e.g. widths)
 */
export function AddToOrderButton({
  item,
  size = "sm",
  className,
}: {
  item: EquipmentOrderItem;
  size?: "sm" | "md";
  className?: string;
}) {
  const [order, setOrder] = useAtom(equipmentOrderAtom);
  const inOrder = order.some((entry) => entry.id === item.id);

  return (
    <Button
      type="button"
      variant={inOrder ? "secondary" : "primary"}
      size={size}
      className={tw(className)}
      onClick={() =>
        setOrder((current) =>
          inOrder
            ? current.filter((entry) => entry.id !== item.id)
            : [...current, item]
        )
      }
    >
      <span className="inline-flex items-center gap-1.5">
        {inOrder ? (
          <CheckIcon className="size-4" aria-hidden />
        ) : (
          <PlusIcon className="size-4" aria-hidden />
        )}
        {inOrder ? "In order" : "Add to order"}
      </span>
    </Button>
  );
}
