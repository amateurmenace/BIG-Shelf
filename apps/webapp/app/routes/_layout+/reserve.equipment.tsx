/**
 * Member Equipment Catalog — `/reserve/equipment`
 *
 * Browse + search the org's bookable equipment. Available items link into the
 * existing, tested `/assets/$id/overview/create-new-booking` flow (asset
 * pre-selected, date picker, conflict detection, self-service custodian
 * forced to self); taken items offer the waitlist instead. The member's own
 * waitlist is managed at the bottom of the page.
 *
 * Moved out of the old single-page `/reserve` when the portal became a
 * multi-page app with a dashboard front door.
 *
 * @see {@link file://./reserve.tsx} — the section layout + shared gate
 * @see {@link file://./reserve._index.tsx} — the member dashboard
 * @see {@link file://./../../modules/big-waitlist/service.server.ts} — waitlist logic
 */
import { AssetStatus } from "@prisma/client";
import { PackageIcon } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import { refreshExpiredAssetImages } from "~/modules/asset/service.server";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import {
  cancelWaitlistEntry,
  getMemberWaitlist,
  joinWaitlist,
} from "~/modules/big-waitlist/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";
import { tw } from "~/utils/tw";

/** Equipment cards per catalog page. */
const EQUIPMENT_PER_PAGE = 24;

/**
 * Friendly labels for asset statuses shown in the catalog. String-keyed (not the
 * Prisma enum) because enum *values* are `undefined` in the browser build.
 */
const ASSET_STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  CHECKED_OUT: "Checked out",
  IN_CUSTODY: "In custody",
};

/**
 * Loads the searchable, paginated catalog plus the member's waitlist. The
 * catalog shows every bookable asset — available ones to reserve now, taken
 * ones so members can join the waitlist.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const url = new URL(request.url);
    const search = (url.searchParams.get("q") ?? "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

    const equipmentWhere = {
      organizationId,
      availableToBook: true,
      ...(search
        ? { title: { contains: search, mode: "insensitive" as const } }
        : {}),
    };

    const [availableCount, equipment, equipmentCount, waitlist] =
      await Promise.all([
        db.asset.count({
          where: {
            organizationId,
            availableToBook: true,
            status: AssetStatus.AVAILABLE,
          },
        }),
        db.asset.findMany({
          where: equipmentWhere,
          select: {
            id: true,
            title: true,
            status: true,
            // Image fields power the catalog card photo; organizationId +
            // mainImageExpiration let us re-sign expired URLs below.
            organizationId: true,
            mainImage: true,
            thumbnailImage: true,
            mainImageExpiration: true,
            category: { select: { name: true, color: true } },
          },
          orderBy: [{ status: "asc" }, { title: "asc" }],
          take: EQUIPMENT_PER_PAGE,
          skip: (page - 1) * EQUIPMENT_PER_PAGE,
        }),
        db.asset.count({ where: equipmentWhere }),
        getMemberWaitlist({ organizationId, userId }),
      ]);

    // Re-sign any expired Supabase signed URLs server-side so catalog photos
    // never 404 (render-stability rule: fix image URLs in the loader).
    const equipmentWithImages = await refreshExpiredAssetImages(equipment);

    // Assets the member already holds an ACTIVE waitlist entry for — WAITING or
    // NOTIFIED. Including NOTIFIED means an item that got re-taken while the
    // member was notified shows "On waitlist" (not "Join waitlist"), so the card
    // can't create a second, duplicate entry.
    const waitlistedAssetIds = waitlist
      .filter((entry) => ["WAITING", "NOTIFIED"].includes(String(entry.status)))
      .map((entry) => entry.asset?.id)
      .filter((id): id is string => Boolean(id));

    const totalPages = Math.max(
      1,
      Math.ceil(equipmentCount / EQUIPMENT_PER_PAGE)
    );

    const header: HeaderData = { title: "Reserve equipment" };

    return data(
      payload({
        header,
        availableCount,
        equipment: equipmentWithImages,
        search,
        page,
        totalPages,
        waitlist,
        waitlistedAssetIds,
      })
    );
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Handles member waitlist mutations: `join-waitlist` (assetId) and
 * `cancel-waitlist` (waitlistId). Gated identically to the loader; on success
 * the loader revalidates so the page reflects the change.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.create,
    });

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "join-waitlist") {
      const assetId = String(formData.get("assetId") ?? "");
      await joinWaitlist({
        organizationId,
        assetId,
        requestedByUserId: userId,
      });
    } else if (intent === "cancel-waitlist") {
      const waitlistId = String(formData.get("waitlistId") ?? "");
      await cancelWaitlistEntry({ id: waitlistId, organizationId, userId });
    }

    return payload({ ok: true });
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => <Link to="/reserve/equipment">Reserve equipment</Link>,
  name: "reserve.equipment",
};

/**
 * The equipment card's photo (or a placeholder). The image zooms gently on
 * hover (the card is the `group`); taken items are dimmed so availability reads
 * at a glance.
 *
 * @param props.image - The asset's photo URL (mainImage, falling back to
 *   thumbnail), or null when the asset has none
 * @param props.available - Whether the item is currently available
 */
function EquipmentImage({
  image,
  available,
}: {
  image: string | null;
  available: boolean;
}) {
  if (!image) {
    return (
      <div className="flex size-full items-center justify-center text-gray-300">
        <PackageIcon className="size-10" aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={image}
      alt=""
      className={tw(
        "size-full object-cover transition-transform duration-300 ease-out group-hover:scale-105",
        !available && "opacity-75"
      )}
    />
  );
}

/** Builds a catalog query string, preserving the search term across pages. */
function catalogHref(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) {
    params.set("q", search);
  }
  params.set("page", String(page));
  return `/reserve/equipment?${params.toString()}`;
}

/**
 * The catalog page: hero count, search, equipment grid (reserve / join
 * waitlist per item), pagination, and the member's waitlist.
 */
export default function ReserveEquipmentCatalog() {
  const {
    availableCount,
    equipment,
    search,
    page,
    totalPages,
    waitlist,
    waitlistedAssetIds,
  } = useLoaderData<typeof loader>();
  const disabled = useDisabled();

  return (
    <div>
      <Header />

      <div className="p-4 md:p-6">
        {/* Hero */}
        <div className="mb-6 rounded border border-gray-200 bg-white p-4 md:p-6">
          <span className="text-lg font-semibold text-gray-900">
            Reserve equipment
          </span>
          <p className="text-sm text-gray-500">
            {availableCount} {availableCount === 1 ? "item is" : "items are"}{" "}
            currently available to book. Pick one below to start a reservation.
          </p>
        </div>

        {/* Browse + search available equipment */}
        <div className="mb-6 rounded border border-gray-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
            <h2 className="text-sm font-semibold text-gray-900">
              Browse equipment
            </h2>
            <Form method="get" className="flex items-center gap-2">
              <input
                type="search"
                name="q"
                defaultValue={search}
                placeholder="Search equipment…"
                aria-label="Search equipment"
                className="h-9 w-full rounded border border-gray-300 px-3 text-sm md:w-64"
              />
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </Form>
          </div>

          {equipment.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-600">
              {search
                ? `No equipment matches “${search}”.`
                : "No equipment to show right now."}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-4 p-4 md:p-6 lg:grid-cols-3 xl:grid-cols-4">
              {equipment.map((item) => {
                const image = item.mainImage ?? item.thumbnailImage;
                const isAvailable = item.status === "AVAILABLE";
                const onWaitlist = waitlistedAssetIds.includes(item.id);
                const reservePath = `/assets/${item.id}/overview/create-new-booking`;
                return (
                  <li
                    key={item.id}
                    className="group flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lg"
                  >
                    {/* Photo — links straight into the reserve flow when free */}
                    {isAvailable ? (
                      <Link
                        to={reservePath}
                        className="relative block aspect-[4/3] overflow-hidden bg-gray-50"
                        aria-label={`Reserve ${item.title}`}
                      >
                        <EquipmentImage image={image} available={isAvailable} />
                      </Link>
                    ) : (
                      <div className="relative aspect-[4/3] overflow-hidden bg-gray-50">
                        <EquipmentImage image={image} available={isAvailable} />
                        <span className="absolute left-2 top-2 rounded-full bg-gray-900/70 px-2 py-0.5 text-xs font-medium text-white backdrop-blur">
                          {ASSET_STATUS_LABEL[item.status] ?? "Unavailable"}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-1 flex-col gap-2 p-3 md:p-4">
                      <p className="line-clamp-2 text-sm font-medium text-gray-900">
                        {item.title}
                      </p>
                      {item.category ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: item.category.color ?? "#9ca3af",
                            }}
                          />
                          <span className="truncate">{item.category.name}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">
                          Uncategorized
                        </span>
                      )}

                      <div className="mt-auto pt-2">
                        {isAvailable ? (
                          <Button to={reservePath} size="sm" width="full">
                            Reserve
                          </Button>
                        ) : onWaitlist ? (
                          <span className="block rounded border border-gray-200 py-1.5 text-center text-xs font-medium text-gray-500">
                            On waitlist
                          </span>
                        ) : (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="join-waitlist"
                            />
                            <input
                              type="hidden"
                              name="assetId"
                              value={item.id}
                            />
                            <Button
                              type="submit"
                              variant="secondary"
                              size="sm"
                              width="full"
                              disabled={disabled}
                            >
                              Join waitlist
                            </Button>
                          </Form>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 md:px-6">
              <span className="text-xs text-gray-500">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                {page > 1 ? (
                  <Button
                    to={catalogHref(search, page - 1)}
                    variant="secondary"
                    size="sm"
                  >
                    Previous
                  </Button>
                ) : null}
                {page < totalPages ? (
                  <Button
                    to={catalogHref(search, page + 1)}
                    variant="secondary"
                    size="sm"
                  >
                    Next
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {/* The member's waitlist */}
        <div className="rounded border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold text-gray-900">
              Your waitlist
            </h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {waitlist.length}
            </span>
          </div>

          {waitlist.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-600">
              You&apos;re not on any waitlists. Join one from a taken item above
              to be emailed when it frees up.
            </div>
          ) : (
            <ul>
              {waitlist.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-4 border-b border-gray-100 px-4 py-3 last:border-b-0 md:px-6"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {entry.asset?.title ?? "Equipment"}
                    </p>
                    <span className="text-xs text-gray-500">
                      {entry.status === "NOTIFIED"
                        ? "Available now — reserve it!"
                        : "Waiting — we'll email you when it's free"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {entry.status === "NOTIFIED" && entry.asset ? (
                      <Link
                        to={`/assets/${entry.asset.id}/overview/create-new-booking`}
                        className="text-xs font-medium text-primary-700 hover:text-primary-800"
                      >
                        Reserve now
                      </Link>
                    ) : null}
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="cancel-waitlist"
                      />
                      <input type="hidden" name="waitlistId" value={entry.id} />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        disabled={disabled}
                      >
                        Leave
                      </Button>
                    </Form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
