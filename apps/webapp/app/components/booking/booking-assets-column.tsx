import { useMemo, useState } from "react";
import { BookingStatus } from "@prisma/client";
import { useLoaderData } from "react-router";
import { RoomBadge } from "~/components/rooms/room-badge";
import { useBookingStatusHelpers } from "~/hooks/use-booking-status";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import type { BookingPageLoaderData } from "~/routes/_layout+/bookings.$bookingId.overview";
import type { AssetWithBooking } from "~/routes/_layout+/bookings.$bookingId.overview.manage-assets";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";

/**
 * Type assertion helper for booking assets.
 * The loader enriches partial booking assets with full asset details via assetDetailsMap,
 * but TypeScript can't infer this enrichment. This helper documents the intentional
 * assertion and provides a single point of type conversion.
 */
function asEnrichedAssets<T>(assets: T[]): AssetWithBooking[] {
  return assets as unknown as AssetWithBooking[];
}

function asEnrichedAsset<T>(asset: T): AssetWithBooking {
  return asset as unknown as AssetWithBooking;
}
import { BookingAssetsFilters } from "./booking-assets-filters";
import KitRow from "./kit-row";
import ListAssetContent from "./list-asset-content";
import ListBulkActionsDropdown from "./list-bulk-actions-dropdown";
import type { LoaderData } from "../list/bulk-actions/bulk-list-header";
import BulkListHeader from "../list/bulk-actions/bulk-list-header";
import { EmptyState } from "../list/empty-state";
import { ListHeader } from "../list/list-header";
import { ListItem } from "../list/list-item";
import ListTitle from "../list/list-title";
import { Button } from "../shared/button";
import { InfoTooltip } from "../shared/info-tooltip";
import TextualDivider from "../shared/textual-divider";
import { Table, Th } from "../table";
import { BookingPagination } from "./booking-pagination";
import When from "../when/when";

export function BookingAssetsColumn() {
  const {
    userId,
    booking,
    items: paginatedItems,
    partialCheckinDetails,
    partialCheckinProgress,
    partialCheckoutDetails,
    checkedOutAssetIds,
  } = useLoaderData<BookingPageLoaderData>();
  // const [searchParams] = useSearchParams();

  const hasItems = paginatedItems?.length > 0;
  const { isBase, isSelfService, isBaseOrSelfService, roles } =
    useUserRoleHelper();
  const { isCompleted, isArchived, isCancelled } = useBookingStatusHelpers(
    booking.status
  );

  // Determine if we should show the check-in columns
  const shouldShowCheckinColumns = useMemo(() => {
    // const currentStatusFilter = searchParams.get("status");
    const hasValidStatus =
      booking.status === BookingStatus.ONGOING ||
      booking.status === BookingStatus.OVERDUE ||
      booking.status === BookingStatus.COMPLETE ||
      booking.status === BookingStatus.ARCHIVED;
    const hasPartialCheckins = partialCheckinProgress?.hasPartialCheckins;
    // const isNotCheckedOutFilter =
    //   currentStatusFilter !== AssetStatus.CHECKED_OUT;

    return hasValidStatus && hasPartialCheckins;
    // && isNotCheckedOutFilter;
  }, [
    booking.status,
    partialCheckinProgress?.hasPartialCheckins,
    // searchParams,
  ]);

  // Determine if we should show the check-OUT columns. Mirrors the check-in
  // columns above. The gate is RECORD-based (`checkedOutAssetIds`, derived from
  // PartialBookingCheckout records) — NOT the status-derived
  // `lifecycleProgress.hasPartialCheckouts`. The cell values come from
  // `partialCheckoutDetails` (the same records), so gating on status would
  // render empty columns for ordinary all-at-once checkouts (which flip assets
  // to CHECKED_OUT without writing any partial-checkout records). RESERVED is a
  // valid status here (assets can be progressively checked out while the booking
  // is still reserved), alongside the in-progress and finished states.
  const shouldShowCheckoutColumns = useMemo(() => {
    const hasValidStatus =
      booking.status === BookingStatus.RESERVED ||
      booking.status === BookingStatus.ONGOING ||
      booking.status === BookingStatus.OVERDUE ||
      booking.status === BookingStatus.COMPLETE ||
      booking.status === BookingStatus.ARCHIVED;
    const hasPartialCheckouts = checkedOutAssetIds.length > 0;

    return hasValidStatus && hasPartialCheckouts;
  }, [booking.status, checkedOutAssetIds.length]);

  const manageAssetsUrl = `manage-assets?${new URLSearchParams({
    bookingFrom: new Date(booking.from).toISOString(),
    bookingTo: new Date(booking.to).toISOString(),
    hideUnavailable: "true",
    unhideAssetsBookigIds: booking.id,
  })}`;

  /**
   * BIG: gear that isn't in the system yet can be created from the booking and
   * lands straight in it (`/assets/new?booking=`), instead of leaving the
   * booking, creating the asset, and coming back to add it. Only offered to
   * people who may create assets.
   */
  const newAssetUrl = userHasPermission({
    roles,
    entity: PermissionEntity.asset,
    action: PermissionAction.create,
  })
    ? `/assets/new?booking=${booking.id}`
    : null;

  // Self service can only manage assets for bookings that are DRAFT
  const cantManageAssetsAsBase =
    (isBase || isSelfService) && booking.status !== BookingStatus.DRAFT;

  const [expandedKits, setExpandedKits] = useState<Record<string, boolean>>({});

  // Initially expand all kits
  useMemo(() => {
    const initialExpandState: Record<string, boolean> = {};
    paginatedItems.forEach((item) => {
      if (item.type === "kit") {
        initialExpandState[item.id] = false; // Kits are collapsed by default
      }
    });
    setExpandedKits(initialExpandState);
  }, [paginatedItems]);

  const toggleKitExpansion = (kitId: string) => {
    setExpandedKits((prev) => ({
      ...prev,
      [kitId]: !prev[kitId],
    }));
  };

  const manageAssetsButtonDisabled = useMemo(
    () =>
      isCompleted || isArchived || isCancelled || cantManageAssetsAsBase
        ? {
            reason: isCompleted
              ? "Booking is completed. You cannot change the assets anymore"
              : isArchived
              ? "Booking is archived. You cannot change the assets anymore"
              : isCancelled
              ? "Booking is cancelled. You cannot change the assets anymore"
              : cantManageAssetsAsBase
              ? "You are unable to add assets at this point because the booking is already reserved. Cancel this booking and create another one if you need to make changes."
              : "You need to select a start and end date and save your booking before you can add assets to your booking",
          }
        : false,
    [isCompleted, isArchived, isCancelled, cantManageAssetsAsBase]
  );

  /**
   * Check whether the user can see actions
   * 1. Admin/Owner always can see all
   * 2. SELF_SERVICE can see actions if they are the custodian of the booking
   * 3. BASE can see actions if they are the custodian of the booking
   */

  const canSeeActions =
    !isBaseOrSelfService ||
    (isBaseOrSelfService && booking?.custodianUser?.id === userId);

  function itemsGetter(data: LoaderData) {
    return data.items
      .map((item) => {
        if (item?.type === "kit") {
          // For kits, return the kit's assets first, then the actual kit object
          // This matches what individual kit selection puts in the atom
          return [...item.assets, item.kit];
        } else {
          // For individual assets, return the asset
          return item.assets[0];
        }
      })
      .flat();
  }

  return (
    <div className="flex-1">
      <div className="w-full">
        <TextualDivider text="Assets & Kits" className="mb-8 lg:hidden" />
        <div className="mb-3 flex gap-4 lg:hidden"></div>
        <div className="flex flex-col">
          {/* Filters */}
          <div className="mb-2">
            <BookingAssetsFilters />
          </div>

          {/* Reserved rooms strip: shows the rooms currently reserved on this
              booking as compact colored badges. Only rendered when the booking
              has at least one reserved room. */}
          {booking.rooms && booking.rooms.length > 0 ? (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-700">Rooms</span>
              {booking.rooms.map((room) => (
                <RoomBadge key={room.id} room={room} />
              ))}
            </div>
          ) : null}

          {/* This is a fake table header */}
          <div className="-mx-4 border border-b-0 bg-white px-4 pb-3 pt-4 text-left font-normal text-gray-600 md:mx-0 md:rounded-t ">
            <BookingAssetsHeader
              canSeeActions={canSeeActions}
              itemsGetter={itemsGetter}
              manageAssetsUrl={manageAssetsUrl}
              manageAssetsButtonDisabled={manageAssetsButtonDisabled}
              newAssetUrl={newAssetUrl}
            />
          </div>

          <div className="-mx-4 overflow-x-auto border border-b-0 border-gray-200 bg-white md:mx-0 md:rounded-b">
            {!hasItems ? (
              <EmptyState
                className="py-10"
                customContent={{
                  title: "Start by defining a booking period",
                  text: "Nothing has been added yet. Use \u201cAdd equipment\u201d to browse the catalog, \u201cScan to add\u201d to scan labels, or \u201cAdd a room\u201d to reserve a space \u2014 all three add to this same booking.",
                  newButtonRoute: manageAssetsUrl,
                  newButtonContent: "Add equipment",
                  buttonProps: {
                    disabled: manageAssetsButtonDisabled,
                  },
                }}
              />
            ) : (
              <>
                <Table className="border-collapse">
                  <ListHeader hideFirstColumn>
                    <BulkListHeader itemsGetter={itemsGetter} />
                    <Th>Name</Th>
                    <Th> </Th>
                    <Th>Category</Th>
                    <Th>Tags</Th>
                    <Th>Location</Th>
                    {shouldShowCheckoutColumns && (
                      <>
                        <Th className="whitespace-nowrap">
                          Checked out on{" "}
                          <InfoTooltip
                            iconClassName="size-4"
                            content={
                              <p>
                                Shows the date when the asset was checked out
                                via a partial check-out.
                              </p>
                            }
                          />
                        </Th>
                        <Th className="whitespace-nowrap">
                          Checked out by{" "}
                          <InfoTooltip
                            iconClassName="size-4"
                            content={
                              <p>
                                Shows the user who checked out the asset via a
                                partial check-out.
                              </p>
                            }
                          />
                        </Th>
                      </>
                    )}
                    {shouldShowCheckinColumns && (
                      <>
                        <Th className="whitespace-nowrap">
                          Checked in on{" "}
                          <InfoTooltip
                            iconClassName="size-4"
                            content={
                              <p>
                                Shows the date when the asset was checked in via
                                a partial check-in.
                              </p>
                            }
                          />
                        </Th>
                        <Th className="whitespace-nowrap">
                          Checked in by{" "}
                          <InfoTooltip
                            iconClassName="size-4"
                            content={
                              <p>
                                Shows the user who checked in the asset via a
                                partial check-in.
                              </p>
                            }
                          />
                        </Th>
                      </>
                    )}
                    <Th> </Th>
                  </ListHeader>
                  <tbody>
                    {/* Render paginated items (kits and individual assets) */}
                    {paginatedItems.map((item) => {
                      if (item.type === "kit") {
                        const kit = item.kit;
                        const isExpanded = expandedKits[item.id] ?? false;
                        if (!kit) {
                          return null;
                        }

                        return (
                          <KitRow
                            key={`kit-${item.id}`}
                            bookingId={booking.id}
                            kit={kit}
                            isExpanded={isExpanded}
                            onToggleExpansion={toggleKitExpansion}
                            bookingStatus={booking.status}
                            assets={asEnrichedAssets(item.assets)}
                            partialCheckinDetails={partialCheckinDetails}
                            shouldShowCheckinColumns={shouldShowCheckinColumns}
                            partialCheckoutDetails={partialCheckoutDetails}
                            shouldShowCheckoutColumns={
                              shouldShowCheckoutColumns
                            }
                          />
                        );
                      }

                      // Individual asset
                      const asset = item.assets[0];
                      return (
                        <ListItem key={`asset-${asset.id}`} item={asset}>
                          <ListAssetContent
                            item={asEnrichedAsset(asset)}
                            partialCheckinDetails={partialCheckinDetails}
                            shouldShowCheckinColumns={shouldShowCheckinColumns}
                            partialCheckoutDetails={partialCheckoutDetails}
                            shouldShowCheckoutColumns={
                              shouldShowCheckoutColumns
                            }
                          />
                        </ListItem>
                      );
                    })}
                  </tbody>
                </Table>
                <BookingPagination className="border-b" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface BookingAssetsHeaderProps {
  canSeeActions: boolean;
  itemsGetter: (data: any) => any[];
  manageAssetsUrl: string;
  manageAssetsButtonDisabled: any;
  /** BIG: where "New asset" goes; null when the user may not create assets. */
  newAssetUrl: string | null;
}

function BookingAssetsHeader({
  canSeeActions,
  itemsGetter,
  manageAssetsUrl,
  manageAssetsButtonDisabled,
  newAssetUrl,
}: BookingAssetsHeaderProps) {
  const { isMd } = useViewportHeight();
  // const [searchParams] = useSearchParams();
  // const statusFilter = searchParams.get("status");

  // const title = useMemo(() => {
  //   switch (statusFilter) {
  //     case "AVAILABLE":
  //       return "Available Assets & Kits";
  //     case "CHECKED_OUT":
  //       return "Checked out Assets & Kits";
  //     default:
  //       return "Assets & Kits";
  //   }
  // }, [statusFilter]);

  if (isMd) {
    // Desktop layout: everything in one row
    return (
      <div className="flex justify-between">
        <ListTitle
          title={"Equipment in this booking"}
          titleClassName="text-transform normal-case"
          hasBulkActions
          itemsGetter={itemsGetter}
          disableSelectAllItems
        />

        <When truthy={canSeeActions}>
          <div className="flex items-center gap-2">
            <ListBulkActionsDropdown />
            {/* BIG: the three "add" routes are spelled out — "Add assets" used
                to be the only labelled one, so people did not realise scanning
                and rooms added to the same booking. */}
            <Button
              icon="scan"
              variant="secondary"
              to="scan-assets"
              disabled={manageAssetsButtonDisabled}
              tooltip="Scan QR codes or barcodes to add equipment"
            >
              Scan to add
            </Button>
            {/* Entry point to manage the booking's reserved rooms. Gated by the
                same condition as "Add assets" (manage-rooms route owned by
                another agent). Link button — no `type` needed. */}
            <Button
              to="manage-rooms"
              variant="secondary"
              className="whitespace-nowrap"
              disabled={manageAssetsButtonDisabled}
              tooltip="Reserve a room as part of this booking"
            >
              Add a room
            </Button>
            {newAssetUrl ? (
              <Button
                to={newAssetUrl}
                variant="secondary"
                className="whitespace-nowrap"
                disabled={manageAssetsButtonDisabled}
                tooltip="Not in the system yet? Create it — it's added to this booking when you save"
              >
                New asset
              </Button>
            ) : null}
            <Button
              to={manageAssetsUrl}
              icon="plus"
              className="whitespace-nowrap"
              disabled={manageAssetsButtonDisabled}
              tooltip="Browse the equipment catalog and pick items"
            >
              Add equipment
            </Button>
          </div>
        </When>
      </div>
    );
  }

  // Mobile layout: two rows
  return (
    <div>
      {/* First row: ListTitle and ListBulkActionsDropdown */}
      <div className="flex items-start justify-between">
        <ListTitle
          title="Equipment in this booking"
          hasBulkActions
          itemsGetter={itemsGetter}
          disableSelectAllItems
        />
        <When truthy={canSeeActions}>
          <ListBulkActionsDropdown />
        </When>
      </div>

      {/* Second row: Scan and Manage assets buttons */}
      <When truthy={canSeeActions}>
        <div className="flex gap-2">
          <Button
            icon="scan"
            variant="secondary"
            to="scan-assets"
            disabled={manageAssetsButtonDisabled}
            className="flex-1"
          >
            Scan
          </Button>
          {/* Entry point to manage the booking's reserved rooms. Gated by the
              same condition as "Add assets". Link button — no `type` needed. */}
          <Button
            to="manage-rooms"
            variant="secondary"
            className="flex-1 whitespace-nowrap"
            disabled={manageAssetsButtonDisabled}
          >
            Room
          </Button>
          <Button
            to={manageAssetsUrl}
            icon="plus"
            className="flex-1 whitespace-nowrap"
            disabled={manageAssetsButtonDisabled}
          >
            Equipment
          </Button>
        </div>
        {newAssetUrl ? (
          <Button
            to={newAssetUrl}
            variant="secondary"
            className="mt-2 w-full whitespace-nowrap"
            disabled={manageAssetsButtonDisabled}
          >
            New asset (not in the system yet)
          </Button>
        ) : null}
      </When>
    </div>
  );
}
