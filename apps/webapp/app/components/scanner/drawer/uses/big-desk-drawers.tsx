/**
 * BIG desk drawers — "Check in equipment" / "Check out equipment" scanner
 * quick actions.
 *
 * Staff sweep gear labels at the front desk; scanned items collect in this
 * drawer, obvious problems surface as resolvable blockers (wrong status, kit
 * members, invalid codes), and one tap posts the pile to `/api/big-desk`,
 * which finds each asset's booking and runs the upstream partial
 * check-in/check-out per booking. The result dialog then lists exactly what
 * moved (per booking) and anything that needs attention.
 *
 * BIG-only additive file; wired up in the scanner's ActionSwitcher.
 *
 * @see {@link file://./../../../../routes/api+/big-desk.ts}
 * @see {@link file://./../action-switcher.tsx}
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { AssetStatus } from "@prisma/client";
import { useAtomValue, useSetAtom } from "jotai";
import { CircleX } from "lucide-react";
import { z } from "zod";
import {
  clearScannedItemsAtom,
  removeScannedItemAtom,
  removeScannedItemsByAssetIdAtom,
  removeMultipleScannedItemsAtom,
  scannedItemsAtom,
  scannedItemIdsAtom,
} from "~/atoms/qr-scanner";
import { CheckmarkIcon } from "~/components/icons/library";
import { Button } from "~/components/shared/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";
import { Spinner } from "~/components/shared/spinner";
import type {
  DeskFailure,
  DeskResponse,
  DeskResult,
} from "~/routes/api+/big-desk";
import type {
  AssetFromQr,
  KitFromQr,
} from "~/routes/api+/get-scanned-item.$qrId";
import { objectToFormData } from "~/utils/object-to-form-data";
import { createBlockers } from "../blockers-factory";
import ConfigurableDrawer from "../configurable-drawer";
import { GenericItemRow, DefaultLoadingState } from "../generic-item-row";
import { AssetRow, KitRow } from "./assign-custody-drawer";

/** Minimum shape the drawer submits. */
export const DeskItemsSchema = z.object({
  assetIds: z.array(z.string()).min(1),
});

type DeskMode = "check-in" | "check-out";

/** Per-mode copy. */
const MODE_COPY: Record<
  DeskMode,
  { title: string; cta: string; doing: string; done: string }
> = {
  "check-in": {
    title: "Scan items being returned",
    cta: "Check in",
    doing: "Checking in",
    done: "checked in",
  },
  "check-out": {
    title: "Scan items being picked up",
    cta: "Check out",
    doing: "Checking out",
    done: "checked out",
  },
};

/** "Check in equipment" drawer. */
export function BigDeskCheckinDrawer(props: DeskDrawerShellProps) {
  return <DeskDrawer mode="check-in" {...props} />;
}

/** "Check out equipment" drawer. */
export function BigDeskCheckoutDrawer(props: DeskDrawerShellProps) {
  return <DeskDrawer mode="check-out" {...props} />;
}

type DeskDrawerShellProps = {
  className?: string;
  style?: CSSProperties;
  isLoading?: boolean;
  defaultExpanded?: boolean;
};

/**
 * The shared drawer: blockers depend on the mode, submission posts the
 * remaining asset ids to `/api/big-desk`.
 */
function DeskDrawer({
  mode,
  className,
  style,
  isLoading,
  defaultExpanded = false,
}: DeskDrawerShellProps & { mode: DeskMode }) {
  const items = useAtomValue(scannedItemsAtom);
  const clearList = useSetAtom(clearScannedItemsAtom);
  const removeItem = useSetAtom(removeScannedItemAtom);
  const removeAssetsFromList = useSetAtom(removeScannedItemsByAssetIdAtom);
  const removeItemsFromList = useSetAtom(removeMultipleScannedItemsAtom);

  const assets = Object.values(items)
    .filter((item) => !!item && item.data && item.type === "asset")
    .map((item) => item?.data as AssetFromQr);

  const errors = Object.entries(items).filter(([, item]) => !!item?.error);

  // Kits (and kit-member assets) are handled from the booking page — the
  // desk endpoint moves loose assets only.
  const assetsInKits = assets
    .filter((asset) => !!asset.kitId)
    .map((asset) => asset.id);
  const kitQrIds = Object.entries(items)
    .filter(([, item]) => item?.type === "kit")
    .map(([qrId]) => qrId);

  // Wrong-status blockers per mode.
  const wrongStatusAssets = assets
    .filter((asset) =>
      mode === "check-in"
        ? asset.status !== AssetStatus.CHECKED_OUT
        : asset.status === AssetStatus.CHECKED_OUT
    )
    .map((asset) => asset.id);

  const blockerConfigs = [
    {
      condition: wrongStatusAssets.length > 0,
      count: wrongStatusAssets.length,
      message: (count: number) =>
        mode === "check-in" ? (
          <>
            <strong>{`${count} asset${
              count > 1 ? "s aren't" : " isn't"
            }`}</strong>{" "}
            checked out, so there's nothing to check in.
          </>
        ) : (
          <>
            <strong>{`${count} asset${count > 1 ? "s are" : " is"}`}</strong>{" "}
            already <strong>checked out</strong>.
          </>
        ),
      onResolve: () => removeAssetsFromList(wrongStatusAssets),
    },
    {
      condition: assetsInKits.length > 0,
      count: assetsInKits.length,
      message: (count: number) => (
        <>
          <strong>{`${count} asset${count > 1 ? "s are" : " is"}`}</strong> part
          of a kit.
        </>
      ),
      description: "Note: handle kit gear from its booking page.",
      onResolve: () => removeAssetsFromList(assetsInKits),
    },
    {
      condition: kitQrIds.length > 0,
      count: kitQrIds.length,
      message: (count: number) => (
        <>
          <strong>{`${count} kit${count > 1 ? "s" : ""}`}</strong> can't be
          processed from the scanner.
        </>
      ),
      description: "Note: check kits in/out from their booking page.",
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
      removeAssetsFromList([...wrongStatusAssets, ...assetsInKits]);
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

  return (
    <ConfigurableDrawer
      schema={DeskItemsSchema}
      items={items}
      onClearItems={clearList}
      title={MODE_COPY[mode].title}
      isLoading={isLoading}
      renderItem={renderItemRow}
      Blockers={Blockers}
      defaultExpanded={defaultExpanded}
      className={className}
      style={style}
      form={<DeskSubmit mode={mode} disableSubmit={hasBlockers} />}
    />
  );
}

type DeskState =
  | { phase: "idle" }
  | { phase: "processing" }
  | { phase: "done"; results: DeskResult[]; failures: DeskFailure[] }
  | { phase: "error"; message: string };

/** The submit button + result dialog. */
function DeskSubmit({
  mode,
  disableSubmit,
}: {
  mode: DeskMode;
  disableSubmit: boolean;
}) {
  const [state, setState] = useState<DeskState>({ phase: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { assetIds } = useAtomValue(scannedItemIdsAtom);
  const clearItems = useSetAtom(clearScannedItemsAtom);
  const copy = MODE_COPY[mode];

  function submit() {
    setDialogOpen(true);
    setState({ phase: "processing" });

    fetch("/api/big-desk", {
      method: "POST",
      body: objectToFormData({
        intent: mode,
        assetIds: assetIds.filter(Boolean),
      }),
    })
      .then((response) => response.json())
      .then((json: { error?: { message: string } } | DeskResponse) => {
        if ("error" in json && json.error) {
          setState({ phase: "error", message: json.error.message });
        } else {
          const ok = json as DeskResponse;
          setState({
            phase: "done",
            results: ok.results ?? [],
            failures: ok.failures ?? [],
          });
        }
      })
      .catch(() => {
        setState({
          phase: "error",
          message: "Something went wrong. Please try again.",
        });
      });
  }

  function cleanup() {
    // Keep the pile only when everything failed outright, so staff can retry.
    if (state.phase === "done") {
      clearItems();
    }
    setState({ phase: "idle" });
  }

  return (
    <>
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) cleanup();
          setDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.doing} equipment</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-left">
                {state.phase === "processing" ? (
                  <div className="flex items-center gap-2">
                    <Spinner />
                    <span>{copy.doing}…</span>
                  </div>
                ) : null}

                {state.phase === "error" ? (
                  <div className="flex items-start gap-2">
                    <CircleX className="mt-0.5 size-[18px] shrink-0 text-error-500" />
                    <span>{state.message}</span>
                  </div>
                ) : null}

                {state.phase === "done" ? (
                  <>
                    {state.results.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {state.results.map((result) => (
                          <div
                            key={result.bookingId}
                            className="flex items-start gap-2"
                          >
                            <span className="mt-0.5 shrink-0 text-green-700">
                              <CheckmarkIcon />
                            </span>
                            <span>
                              <strong>{result.assetCount}</strong> item
                              {result.assetCount === 1 ? "" : "s"} {copy.done}{" "}
                              for{" "}
                              <Button
                                to={`/bookings/${result.bookingId}`}
                                variant="link"
                                className="inline font-medium"
                              >
                                {result.bookingName}
                              </Button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No items were {copy.done}.</p>
                    )}

                    {state.failures.length > 0 ? (
                      <div className="rounded border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700">
                        <p className="mb-1 font-medium">Needs attention:</p>
                        <ul className="list-inside list-disc">
                          {state.failures.map((failure) => (
                            <li key={failure.assetId}>
                              <strong>{failure.title}</strong> —{" "}
                              {failure.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="secondary">
                Done
              </Button>
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="px-4 pb-4 md:pl-0">
        <Button
          type="button"
          variant="primary"
          width="full"
          disabled={disableSubmit || assetIds.length === 0}
          onClick={submit}
        >
          {copy.cta}{" "}
          {assetIds.length > 0
            ? `${assetIds.length} item${assetIds.length === 1 ? "" : "s"}`
            : "equipment"}
        </Button>
      </div>
    </>
  );
}
