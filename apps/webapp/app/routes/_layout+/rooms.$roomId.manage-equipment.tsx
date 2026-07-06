/**
 * Manage Room Equipment Route
 *
 * Modal route for assigning/removing equipment (assets) to/from a Room. Rooms
 * are a first-class, reservable entity that can hold assets — this surface is
 * the "fill the room with equipment" picker, mirroring the kit
 * `manage-assets` and location `manage-assets` modals but stripped of any
 * booking-conflict / disabled-asset logic (a room simply holds whatever assets
 * the user selects).
 *
 * Flow:
 * - Loader: org-scopes the room via `requirePermission(room, update)`, loads the
 *   room's current asset IDs (to pre-select the checkboxes) plus the org's
 *   paginated/filterable assets.
 * - Action: parses the full desired set of `assetIds` and hands it to
 *   {@link updateRoomAssets}, which computes the connect/disconnect deltas and
 *   validates every ID belongs to the org. On success, redirects back to the
 *   room detail page.
 *
 * @see {@link file://../../modules/room/service.server.ts} — `updateRoomAssets`
 * @see {@link file://./kits.$kitId.assets.manage-assets.tsx} — the richer kit variant this mirrors
 * @see {@link file://./locations.$locationId.assets.manage-assets.tsx} — the lean location variant
 */

import { useEffect, useRef } from "react";
import { AssetStatus } from "@prisma/client";
import { useAtomValue, useSetAtom } from "jotai";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  redirect,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { z } from "zod";
import {
  selectedBulkItemsAtom,
  selectedBulkItemsCountAtom,
  setSelectedBulkItemAtom,
  setSelectedBulkItemsAtom,
} from "~/atoms/list";
import { AssetImage } from "~/components/assets/asset-image/component";
import { AssetStatusBadge } from "~/components/assets/asset-status-badge";
import { ASSET_SORTING_OPTIONS } from "~/components/assets/assets-index/filters";
import { ListItemTagsColumn } from "~/components/assets/assets-index/list-item-tags-column";
import { CategoryBadge } from "~/components/assets/category-badge";
import { StatusFilter } from "~/components/booking/status-filter";
import { Form } from "~/components/custom-form";
import DynamicDropdown from "~/components/dynamic-dropdown/dynamic-dropdown";
import { ChevronRight } from "~/components/icons/library";
import ImageWithPreview from "~/components/image-with-preview/image-with-preview";
import { List } from "~/components/list";
import { Filters } from "~/components/list/filters";
import { SortBy } from "~/components/list/filters/sort-by";
import { LocationBadge } from "~/components/location/location-badge";
import { Button } from "~/components/shared/button";
import { Td, Th } from "~/components/table";
import { db } from "~/database/db.server";
import { getPaginatedAndFilterableAssets } from "~/modules/asset/service.server";
import type { AssetsFromViewItem } from "~/modules/asset/types";
import { updateRoomAssets } from "~/modules/room/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import { payload, error, getParams, parseData } from "~/utils/http.server";
import { isSelectingAllItems } from "~/utils/list";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header.title) },
];

/** Return type of the loader, used to type `useLoaderData`. */
type LoaderData = typeof loader;

/**
 * Loads the room (org-scoped) plus the organization's paginated, filterable
 * assets so the user can pick which equipment lives in the room.
 *
 * @param args.context - Remix context (source of the auth session / userId)
 * @param args.request - The incoming request (source of search params / filters)
 * @param args.params - Route params (must contain `roomId`)
 * @returns The room's current asset IDs and the paginated asset list payload
 * @throws {ShelfError} 404 if the room is not found in the caller's org, or a
 *   wrapped error if permission/data fetching fails
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { roomId } = getParams(params, z.object({ roomId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.update,
    });

    // Room lookup and paginated assets query are independent — run in parallel.
    const [
      room,
      {
        assets,
        totalAssets,
        categories,
        totalCategories,
        tags,
        totalTags,
        locations,
        totalLocations,
        search,
        page,
        totalPages,
        perPage,
      },
    ] = await Promise.all([
      db.room
        .findFirstOrThrow({
          where: { id: roomId, organizationId },
          select: {
            id: true,
            name: true,
            // Current asset IDs are used to pre-select the checkboxes.
            assets: { select: { id: true } },
          },
        })
        .catch((cause) => {
          throw new ShelfError({
            cause,
            title: "Room not found",
            message:
              "The room you are trying to access does not exist or you do not have permission to access it.",
            additionalData: { roomId, userId, organizationId },
            status: 404,
            label: "Room",
          });
        }),
      getPaginatedAndFilterableAssets({
        request,
        organizationId,
      }),
    ]);

    const modelName = {
      singular: "asset",
      plural: "assets",
    };

    return payload({
      header: {
        title: `Move assets to ‘${room.name}’`,
        subHeading:
          "Search your database for assets that you would like to place in this room.",
      },
      searchFieldLabel: "Search assets",
      searchFieldTooltip: {
        title: "Search your asset database",
        text: "Search assets based on asset name or description, category, tag, location, custodian name. Simply separate your keywords by a space: 'Laptop lenovo 2020'.",
      },
      showSidebar: true,
      noScroll: true,
      room,
      items: assets,
      totalItems: totalAssets,
      categories,
      tags,
      search,
      page,
      totalCategories,
      totalTags,
      locations,
      totalLocations,
      totalPages,
      perPage,
      modelName,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Persists the user's selected equipment for the room.
 *
 * Reads the full desired set of `assetIds` from the form (supports the
 * `ALL_SELECTED_KEY` select-all sentinel) and delegates to
 * {@link updateRoomAssets}, which computes the connect/disconnect deltas and
 * org-validates every ID. Redirects back to the room detail page on success.
 *
 * @param args.context - Remix context (source of the auth session / userId)
 * @param args.request - The incoming request (source of the submitted form data)
 * @param args.params - Route params (must contain `roomId`)
 * @returns A redirect to `/rooms/{roomId}`, or a wrapped error response
 * @throws {ShelfError} Wrapped as an error `data` response on failure
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { roomId } = getParams(params, z.object({ roomId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.update,
    });

    const { assetIds } = parseData(
      await request.formData(),
      z.object({
        assetIds: z.array(z.string()).optional().default([]),
      }),
      { additionalData: { userId, organizationId, roomId } }
    );

    await updateRoomAssets({
      roomId,
      organizationId,
      assetIds,
      userId,
      request,
    });

    return redirect(`/rooms/${roomId}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    return data(error(reason), { status: reason.status });
  }
}

/**
 * Equipment picker modal for a room.
 *
 * Renders the org's assets as a selectable list (checkboxes via the shared
 * bulk-selection atoms), pre-selecting the assets already in the room. On
 * confirm, submits the full selected set for the action to reconcile.
 */
export default function ManageRoomEquipment() {
  const { room, totalItems } = useLoaderData<LoaderData>();

  const navigation = useNavigation();
  const isSearching = isFormProcessing(navigation.state);

  const formRef = useRef<HTMLFormElement>(null);
  const submit = useSubmit();

  const selectedBulkItems = useAtomValue(selectedBulkItemsAtom);
  const updateItem = useSetAtom(setSelectedBulkItemAtom);
  const setSelectedBulkItems = useSetAtom(setSelectedBulkItemsAtom);
  const selectedBulkItemsCount = useAtomValue(selectedBulkItemsCountAtom);
  const hasSelectedAllItems = isSelectingAllItems(selectedBulkItems);

  /**
   * Pre-select the assets already assigned to the room based on the route data.
   */
  useEffect(() => {
    setSelectedBulkItems(room.assets);
  }, [room.assets, setSelectedBulkItems]);

  /** Submit the hidden form once the user confirms their selection. */
  function handleSubmit() {
    void submit(formRef.current);
  }

  return (
    <div className="flex size-full flex-col overflow-y-hidden">
      <div className="border-b px-6 md:pb-3">
        <Filters
          className="md:border-0 md:p-0"
          slots={{
            "left-of-search": <StatusFilter statusItems={AssetStatus} />,
            "right-of-search": (
              <SortBy
                sortingOptions={ASSET_SORTING_OPTIONS}
                defaultSortingBy="createdAt"
              />
            ),
          }}
        ></Filters>
      </div>
      <div className="flex justify-around gap-2 border-b p-3 lg:gap-4">
        <DynamicDropdown
          trigger={
            <div className="flex h-6 cursor-pointer items-center gap-2">
              Categories <ChevronRight className="hidden rotate-90 md:inline" />
            </div>
          }
          model={{ name: "category", queryKey: "name" }}
          label="Filter by category"
          initialDataKey="categories"
          countKey="totalCategories"
        />
        <DynamicDropdown
          trigger={
            <div className="flex h-6 cursor-pointer items-center gap-2">
              Tags <ChevronRight className="hidden rotate-90 md:inline" />
            </div>
          }
          model={{ name: "tag", queryKey: "name" }}
          label="Filter by tags"
          initialDataKey="tags"
          countKey="totalTags"
        />
        <DynamicDropdown
          trigger={
            <div className="flex h-6 cursor-pointer items-center gap-2">
              Locations <ChevronRight className="hidden rotate-90 md:inline" />
            </div>
          }
          model={{ name: "location", queryKey: "name" }}
          label="Filter by Location"
          initialDataKey="locations"
          countKey="totalLocations"
          renderItem={({ metadata }) => (
            <div className="flex items-center gap-2">
              <ImageWithPreview
                thumbnailUrl={metadata.thumbnailUrl}
                alt={metadata.name}
                className="size-6 rounded-[2px]"
              />
              <div>{metadata.name}</div>
            </div>
          )}
        />
      </div>
      {/* Body of the modal - this is the scrollable area */}
      <div className="flex-1 overflow-y-auto px-5 md:px-0">
        <List
          ItemComponent={RowComponent}
          /** Clicking a row toggles the asset in the selected-items atom. */
          navigate={(_assetId, item) => {
            updateItem(item);
          }}
          customEmptyStateContent={{
            title: "You haven't added any assets yet.",
            text: "What are you waiting for? Create your first asset now!",
            newButtonRoute: "/assets/new",
            newButtonContent: "New asset",
          }}
          className="-mx-5 flex h-full flex-col justify-start border-0"
          bulkActions={<> </>}
          headerChildren={
            <>
              <Th>Category</Th>
              <Th>Tags</Th>
              <Th>Location</Th>
            </>
          }
          disableSelectAllItems={true}
        />
      </div>
      {/* Footer of the modal - fixed at the bottom */}
      <footer className="item-center mt-auto flex shrink-0 justify-between border-t px-6 py-3">
        <p>
          {hasSelectedAllItems ? totalItems : selectedBulkItemsCount} selected
        </p>

        <div className="flex gap-3">
          <Button variant="secondary" to="..">
            Close
          </Button>
          <Form method="post" ref={formRef}>
            {selectedBulkItems.map((asset, i) => (
              <input
                key={asset.id}
                type="hidden"
                name={`assetIds[${i}]`}
                value={asset.id}
              />
            ))}

            <Button type="button" onClick={handleSubmit} disabled={isSearching}>
              Confirm
            </Button>
          </Form>
        </div>
      </footer>
    </div>
  );
}

/**
 * Single asset row in the equipment picker.
 *
 * Shows the asset's image, title, status badge, category, tags and location —
 * no availability/conflict affordances (a room holds any asset regardless of
 * status).
 *
 * @param props.item - The asset to render, as returned by the assets view
 */
const RowComponent = ({ item }: { item: AssetsFromViewItem }) => {
  const { category, tags, location } = item;

  return (
    <>
      {/* Name */}
      <Td className={tw("w-full min-w-[330px] p-0 md:p-0")}>
        <div className="flex items-center gap-3 p-4 md:pr-6">
          <div className="flex items-center gap-3">
            <div className="flex size-14 shrink-0 items-center justify-center">
              <AssetImage
                asset={{
                  id: item.id,
                  mainImage: item.mainImage,
                  thumbnailImage: item.thumbnailImage,
                  mainImageExpiration: item.mainImageExpiration,
                }}
                alt={`Image of ${item.title}`}
                className="size-full rounded-[4px] border object-cover"
              />
            </div>
            <div className="flex flex-col gap-y-1">
              <p className="word-break whitespace-break-spaces font-medium">
                {item.title}
              </p>
              <AssetStatusBadge
                id={item.id}
                status={item.status}
                availableToBook={item.availableToBook}
              />
            </div>
          </div>
        </div>
      </Td>

      {/* Category */}
      <Td>
        <CategoryBadge category={category} />
      </Td>

      {/* Tags */}
      <Td className="text-left">
        <ListItemTagsColumn tags={tags} />
      </Td>

      {/* Location */}
      <Td>
        {location ? (
          <LocationBadge
            location={{
              id: location.id,
              name: location.name,
              parentId: location.parentId ?? undefined,
              childCount: location._count?.children ?? 0,
            }}
          />
        ) : null}
      </Td>
    </>
  );
};
