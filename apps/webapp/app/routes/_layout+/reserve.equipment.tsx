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
            category: { select: { name: true, color: true } },
          },
          orderBy: [{ status: "asc" }, { title: "asc" }],
          take: EQUIPMENT_PER_PAGE,
          skip: (page - 1) * EQUIPMENT_PER_PAGE,
        }),
        db.asset.count({ where: equipmentWhere }),
        getMemberWaitlist({ organizationId, userId }),
      ]);

    const waitlistedAssetIds = waitlist
      .filter((entry) => String(entry.status) === "WAITING")
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
        equipment,
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
            <ul className="grid grid-cols-1 gap-px bg-gray-100 sm:grid-cols-2 lg:grid-cols-3">
              {equipment.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 bg-white p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {item.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {item.category ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                          <span
                            className="inline-block size-2 rounded-full"
                            style={{
                              backgroundColor: item.category.color ?? "#9ca3af",
                            }}
                          />
                          {item.category.name}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">
                          Uncategorized
                        </span>
                      )}
                      {item.status !== "AVAILABLE" ? (
                        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                          {ASSET_STATUS_LABEL[item.status] ?? "Unavailable"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {item.status === "AVAILABLE" ? (
                    <Button
                      to={`/assets/${item.id}/overview/create-new-booking`}
                      variant="secondary"
                      size="sm"
                    >
                      Reserve
                    </Button>
                  ) : waitlistedAssetIds.includes(item.id) ? (
                    <span className="shrink-0 rounded border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500">
                      On waitlist
                    </span>
                  ) : (
                    <Form method="post" className="shrink-0">
                      <input
                        type="hidden"
                        name="intent"
                        value="join-waitlist"
                      />
                      <input type="hidden" name="assetId" value={item.id} />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        disabled={disabled}
                      >
                        Join waitlist
                      </Button>
                    </Form>
                  )}
                </li>
              ))}
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
