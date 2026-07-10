/**
 * BIG "Make a reservation" scanner drawer.
 *
 * Staff scan a pile of gear at the desk, then one tap opens the NEW BOOKING
 * form with every scanned asset pre-selected (`/bookings/new?assetId=…` —
 * natively supported by the booking form). Dates and custodian get picked
 * there, and all the usual booking validation applies.
 *
 * Kits are blocked here (the new-booking preselect takes asset ids only) —
 * staff add kits from the booking page instead.
 *
 * BIG-only additive file; wired up in the scanner's ActionSwitcher.
 *
 * @see {@link file://./../action-switcher.tsx}
 * @see {@link file://./../../../../routes/_layout+/bookings.new.tsx}
 */
import type { CSSProperties } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router";
import { z } from "zod";
import {
  clearScannedItemsAtom,
  removeScannedItemAtom,
  removeMultipleScannedItemsAtom,
  scannedItemsAtom,
  scannedItemIdsAtom,
} from "~/atoms/qr-scanner";
import { Button } from "~/components/shared/button";
import type {
  AssetFromQr,
  KitFromQr,
} from "~/routes/api+/get-scanned-item.$qrId";
import { createBlockers } from "../blockers-factory";
import ConfigurableDrawer from "../configurable-drawer";
import { GenericItemRow, DefaultLoadingState } from "../generic-item-row";
import { AssetRow, KitRow } from "./assign-custody-drawer";

/** Minimum shape required to proceed. */
export const CreateReservationSchema = z.object({
  assetIds: z.array(z.string()).min(1),
});

/**
 * The drawer.
 */
export default function BigCreateReservationDrawer({
  className,
  style,
  isLoading,
  defaultExpanded = false,
}: {
  className?: string;
  style?: CSSProperties;
  isLoading?: boolean;
  defaultExpanded?: boolean;
}) {
  const navigate = useNavigate();
  const items = useAtomValue(scannedItemsAtom);
  const clearList = useSetAtom(clearScannedItemsAtom);
  const removeItem = useSetAtom(removeScannedItemAtom);
  const removeItemsFromList = useSetAtom(removeMultipleScannedItemsAtom);
  const { assetIds } = useAtomValue(scannedItemIdsAtom);

  const errors = Object.entries(items).filter(([, item]) => !!item?.error);
  const kitQrIds = Object.entries(items)
    .filter(([, item]) => item?.type === "kit")
    .map(([qrId]) => qrId);

  const blockerConfigs = [
    {
      condition: kitQrIds.length > 0,
      count: kitQrIds.length,
      message: (count: number) => (
        <>
          <strong>{`${count} kit${count > 1 ? "s" : ""}`}</strong> can't be
          pre-added from the scanner.
        </>
      ),
      description: "Note: add kits on the booking page after creating it.",
      onResolve: () => removeItemsFromList(kitQrIds),
    },
    {
      condition: errors.length > 0,
      count: errors.length,
      message: (count: number) => (
        <>
          <strong>{`${count} code${count > 1 ? "s are" : " is"}`}</strong>{" "}
          invalid.
        </>
      ),
      onResolve: () => removeItemsFromList(errors.map(([qrId]) => qrId)),
    },
  ];

  const [hasBlockers, Blockers] = createBlockers({
    blockerConfigs,
    onResolveAll: () => {
      removeItemsFromList([...errors.map(([qrId]) => qrId), ...kitQrIds]);
    },
  });

  const renderItemRow = (qrId: string, item: any) => (
    <GenericItemRow
      key={qrId}
      qrId={qrId}
      item={item}
      onRemove={removeItem}
      renderLoading={(id, itemError) => (
        <DefaultLoadingState qrId={id} error={itemError} />
      )}
      renderItem={(itemData) => {
        if (item?.type === "asset" && itemData) {
          return <AssetRow asset={itemData as AssetFromQr} />;
        } else if (item?.type === "kit" && itemData) {
          return <KitRow kit={itemData as KitFromQr} />;
        }
        return null;
      }}
    />
  );

  /** Open the new-booking form with every scanned asset pre-selected. */
  function createReservation() {
    const params = new URLSearchParams();
    for (const id of assetIds) {
      if (id) params.append("assetId", id);
    }
    clearList();
    void navigate(`/bookings/new?${params.toString()}`);
  }

  return (
    <ConfigurableDrawer
      schema={CreateReservationSchema}
      items={items}
      onClearItems={clearList}
      title="Scan items to reserve"
      isLoading={isLoading}
      renderItem={renderItemRow}
      Blockers={Blockers}
      defaultExpanded={defaultExpanded}
      className={className}
      style={style}
      form={
        <div className="px-4 pb-4 md:pl-0">
          <Button
            type="button"
            variant="primary"
            width="full"
            disabled={hasBlockers || assetIds.length === 0}
            onClick={createReservation}
          >
            {assetIds.length === 0
              ? "Scan items to reserve"
              : `Create reservation (${assetIds.length} item${
                  assetIds.length === 1 ? "" : "s"
                })`}
          </Button>
        </div>
      }
    />
  );
}
