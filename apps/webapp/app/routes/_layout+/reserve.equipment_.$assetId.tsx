/**
 * Member Equipment Info — `/reserve/equipment/:assetId`
 *
 * Where a scan (or a catalog tap) lands: everything a member wants to know
 * about one piece of gear — a large photo, description, live availability,
 * and the admin-managed guides (manual links + embedded video explainers,
 * managed on the staff asset page's Guides tab). CTAs: add the item to the
 * scan-to-reserve order, reserve just this item, or join the waitlist when
 * it's taken. Mobile-first: single column, thumb-sized buttons.
 *
 * PRIVACY: the payload is anonymized — status only, never who has the item.
 *
 * @see {@link file://./reserve.scan.tsx} — the scanner that lands here
 * @see {@link file://./reserve.order.tsx} — the order checkout
 * @see {@link file://./assets.$assetId.guides.tsx} — the admin CMS for guides
 * @see {@link file://./../../modules/big-equipment/service.server.ts}
 */
import { BookOpenIcon, LinkIcon, ScanLineIcon } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { z } from "zod";
import { AddToOrderButton } from "~/components/big/reserve/add-to-order-button";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import { refreshExpiredAssetImages } from "~/modules/asset/service.server";
import { getMemberAssetInfo } from "~/modules/big-equipment/service.server";
import { videoEmbedUrl } from "~/modules/big-equipment/shared";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import {
  getMemberWaitlist,
  joinWaitlist,
} from "~/modules/big-waitlist/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";
import { tw } from "~/utils/tw";

/** Route params — the asset id comes from the URL and is untrusted. */
const paramsSchema = z.object({ assetId: z.string() });

/** Friendly labels for statuses (string-keyed: Prisma enum values are
 * undefined in the browser build). */
const ASSET_STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  CHECKED_OUT: "Checked out",
  IN_CUSTODY: "In custody",
};

/**
 * Loads the anonymized info payload: the asset (photo re-signed if expired),
 * its guides, and whether the member already waits for it.
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const [{ asset, guides }, waitlist] = await Promise.all([
      getMemberAssetInfo({ organizationId, assetId }),
      getMemberWaitlist({ organizationId, userId }),
    ]);

    // Re-sign an expired photo URL server-side so the big image never 404s.
    const [assetWithImage] = await refreshExpiredAssetImages([asset]);

    const onWaitlist = waitlist.some(
      (entry) =>
        entry.asset?.id === assetId &&
        ["WAITING", "NOTIFIED"].includes(String(entry.status))
    );

    const header: HeaderData = { title: asset.title };

    return data(payload({ header, asset: assetWithImage, guides, onWaitlist }));
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId, assetId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Handles the "join waitlist" CTA for a taken item (same behavior as the
 * catalog page's action).
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const { assetId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.create,
    });

    const formData = await request.formData();
    parseData(formData, z.object({ intent: z.literal("join-waitlist") }), {
      shouldBeCaptured: false,
    });

    await joinWaitlist({
      organizationId,
      assetId,
      requestedByUserId: userId,
    });

    return payload({ ok: true });
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId, assetId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => "single",
  name: "reserve.equipment.info",
};

/**
 * The info page.
 */
export default function MemberEquipmentInfoPage() {
  const { asset, guides, onWaitlist } = useLoaderData<typeof loader>();
  const disabled = useDisabled();

  const image = asset.mainImage ?? asset.thumbnailImage;
  const isAvailable = String(asset.status) === "AVAILABLE";
  const videos = guides.filter(
    (guide) => String(guide.kind) === "VIDEO" && videoEmbedUrl(guide.url)
  );
  const links = guides.filter((guide) => !videos.includes(guide));

  return (
    <div>
      <Header />

      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:gap-6 md:p-6">
        {/* Photo — large; tap opens the full-size original */}
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {image ? (
            <a
              href={image}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open a full-size photo of ${asset.title}`}
              className="block bg-gray-50"
            >
              <img
                src={image}
                alt={asset.title}
                className="mx-auto max-h-[420px] w-full object-contain"
              />
            </a>
          ) : (
            <div className="flex aspect-[4/3] items-center justify-center bg-gray-50 text-gray-300">
              <BookOpenIcon className="size-12" aria-hidden />
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-gray-100 p-4 md:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={tw(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                  isAvailable
                    ? "bg-success-50 text-success-700"
                    : "bg-warning-50 text-warning-700"
                )}
              >
                <span
                  className={tw(
                    "inline-block size-1.5 rounded-full",
                    isAvailable ? "bg-success-500" : "bg-warning-500"
                  )}
                  aria-hidden
                />
                {ASSET_STATUS_LABEL[String(asset.status)] ?? "Unavailable"}
              </span>
              {asset.category ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{
                      backgroundColor: asset.category.color ?? "#9ca3af",
                    }}
                    aria-hidden
                  />
                  {asset.category.name}
                </span>
              ) : null}
            </div>

            <h1 className="text-xl font-semibold text-gray-900">
              {asset.title}
            </h1>

            {asset.description ? (
              <p className="whitespace-pre-wrap text-sm text-gray-600">
                {asset.description}
              </p>
            ) : null}

            {/* CTAs — thumb-sized, full width on phones */}
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              {isAvailable ? (
                <>
                  <ClientOnly
                    fallback={<div className="h-10 w-full sm:w-36" />}
                  >
                    {() => (
                      <AddToOrderButton
                        item={{
                          id: asset.id,
                          title: asset.title,
                          image: asset.thumbnailImage ?? asset.mainImage,
                        }}
                        size="md"
                        className="w-full sm:w-auto"
                      />
                    )}
                  </ClientOnly>
                  <Button
                    to={`/assets/${asset.id}/overview/create-new-booking`}
                    variant="secondary"
                    className="w-full sm:w-auto"
                  >
                    Reserve just this item
                  </Button>
                </>
              ) : onWaitlist ? (
                <span className="rounded border border-gray-200 px-3 py-2 text-center text-sm font-medium text-gray-500">
                  You&apos;re on the waitlist — we&apos;ll email you when it
                  frees up
                </span>
              ) : (
                <form method="post" className="w-full sm:w-auto">
                  <input type="hidden" name="intent" value="join-waitlist" />
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={disabled}
                    className="w-full sm:w-auto"
                  >
                    Join waitlist
                  </Button>
                </form>
              )}
            </div>
          </div>
        </div>

        {/* Video explainers */}
        {videos.length > 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">
              Watch &amp; learn
            </h2>
            <div className="flex flex-col gap-4">
              {videos.map((video) => (
                <figure key={video.id}>
                  <div className="overflow-hidden rounded-lg">
                    <iframe
                      src={videoEmbedUrl(video.url) ?? undefined}
                      title={video.title}
                      loading="lazy"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      className="aspect-video w-full border-0"
                    />
                  </div>
                  <figcaption className="mt-1.5 text-xs text-gray-500">
                    {video.title}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        ) : null}

        {/* Manuals & links */}
        {links.length > 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900 md:px-5">
              Manuals &amp; resources
            </h2>
            <ul>
              {links.map((guide) => (
                <li key={guide.id}>
                  <a
                    href={guide.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 text-sm text-gray-800 transition last:border-b-0 hover:bg-gray-50 md:px-5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                      {String(guide.kind) === "MANUAL" ? (
                        <BookOpenIcon className="size-4" aria-hidden />
                      ) : (
                        <LinkIcon className="size-4" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {guide.title}
                      </span>
                      <span className="block truncate text-xs text-gray-400">
                        {guide.url}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Keep scanning */}
        <Link
          to="/reserve/scan"
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 p-3 text-sm font-medium text-gray-600 transition hover:border-primary-300 hover:text-primary-700"
        >
          <ScanLineIcon className="size-4" aria-hidden />
          Scan another item
        </Link>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
