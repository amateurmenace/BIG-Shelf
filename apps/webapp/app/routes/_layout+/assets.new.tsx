import { BookingStatus, TagUseFor } from "@prisma/client";
import { useAtomValue } from "jotai";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, redirect, redirectDocument, useLoaderData } from "react-router";
import { dynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import { AssetForm, NewAssetFormSchema } from "~/components/assets/form";
import Header from "~/components/layout/header";
import { db } from "~/database/db.server";
import { useSearchParams } from "~/hooks/search-params";
import { estimateNextSequentialId } from "~/modules/asset/sequential-id.server";
import {
  createAsset,
  getAllEntriesForCreateAndEdit,
  updateAssetMainImage,
} from "~/modules/asset/service.server";
import { sendBookingUpdatedEmail } from "~/modules/booking/email-helpers";
import { updateBookingAssets } from "~/modules/booking/service.server";
import { getActiveCustomFields } from "~/modules/custom-field/service.server";
import { createNote } from "~/modules/note/service.server";
import { assertWhetherQrBelongsToCurrentOrganization } from "~/modules/qr/service.server";
import { buildTagsSet } from "~/modules/tag/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { extractBarcodesFromFormData } from "~/utils/barcode-form-data.server";
import { getClientHint } from "~/utils/client-hints";
import {
  extractCustomFieldValuesFromPayload,
  mergedSchema,
} from "~/utils/custom-fields";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  assertIsPost,
  payload,
  error,
  getCurrentSearchParams,
  getRefererPath,
  parseData,
} from "~/utils/http.server";
import { Logger } from "~/utils/logger";
import { wrapLinkForNote, wrapUserLinkForNote } from "~/utils/markdoc-wrappers";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { slugify } from "~/utils/slugify";

const title = "New asset";
const header = {
  title,
};

/** Bookings that no longer take equipment. */
const CLOSED_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETE,
  BookingStatus.CANCELLED,
  BookingStatus.ARCHIVED,
];

/**
 * BIG: `?booking=` — the booking page's "New asset" button, for gear that
 * isn't in the system yet. The asset is added to that booking when saved.
 *
 * Checked in the loader too, so the page can say which booking and a stale
 * link fails before anyone fills the form in; checked again in the action
 * BEFORE the asset is created, so a refusal creates nothing.
 *
 * @returns The booking, or null when there is no `?booking=`.
 * @throws {ShelfError} 404 when the booking is not in this organization; 400
 *   when it is completed, cancelled or archived.
 * @see .claude/rules/org-scope-user-supplied-ids.md
 */
async function resolveTargetBooking({
  request,
  organizationId,
}: {
  request: Request;
  organizationId: string;
}): Promise<{ id: string; name: string } | null> {
  const bookingId = new URL(request.url).searchParams.get("booking");
  if (!bookingId) return null;

  const booking = await db.booking.findFirst({
    where: { id: bookingId, organizationId },
    select: { id: true, name: true, status: true },
  });

  if (!booking) {
    throw new ShelfError({
      cause: null,
      title: "Booking not found",
      message:
        "The booking this asset was meant for could not be found in this workspace.",
      additionalData: { bookingId, organizationId },
      label: "Booking",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  if (CLOSED_BOOKING_STATUSES.includes(booking.status)) {
    throw new ShelfError({
      cause: null,
      title: "Booking is closed",
      message: `"${
        booking.name
      }" is ${booking.status.toLowerCase()}, so equipment can no longer be added to it.`,
      additionalData: { bookingId, status: booking.status },
      label: "Booking",
      status: 400,
      shouldBeCaptured: false,
    });
  }

  return { id: booking.id, name: booking.name };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.create,
    });
    /**
     * We need to check if the QR code passed in the URL belongs to the current org
     * This is relevant whenever the user is trying to link a new asset with an existing QR code
     * */
    await assertWhetherQrBelongsToCurrentOrganization({
      request,
      organizationId,
    });

    const searchParams = getCurrentSearchParams(request);

    const [
      { categories, totalCategories, tags, locations, totalLocations },
      customFields,
      nextSequentialId,
      targetBooking,
    ] = await Promise.all([
      getAllEntriesForCreateAndEdit({
        organizationId,
        request,
        tagUseFor: TagUseFor.ASSET,
      }),
      getActiveCustomFields({
        organizationId,
        category: searchParams.get("category"),
      }),
      estimateNextSequentialId(organizationId),
      resolveTargetBooking({ request, organizationId }),
    ]);

    return payload({
      targetBooking,
      header,
      categories,
      totalCategories,
      tags,
      totalTags: tags.length,
      locations,
      totalLocations,
      currency: currentOrganization?.currency,
      customFields,
      nextSequentialId,
      // why: the form's Cancel button needs somewhere to go back to. Without
      // it the button rendered as a typeless <button> inside the form and
      // submitted instead of cancelling.
      referer: getRefererPath(request),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <span>{title}</span>,
};

export async function action({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    const { organizationId, canUseBarcodes } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.create,
    });

    /** Here we need to clone the request as we need 2 different streams:
     * 1. Access form data for creating asset
     * 2. Access form data via upload handler to be able to upload the file
     *
     * This solution is based on : https://github.com/remix-run/remix/issues/3971#issuecomment-1222127635
     */
    const clonedRequest = request.clone();

    const formData = await clonedRequest.formData();

    const customFields = await getActiveCustomFields({
      organizationId,
      category: formData.get("category") as string | null,
    });

    const FormSchema = mergedSchema({
      baseSchema: NewAssetFormSchema,
      customFields: customFields.map((cf) => ({
        id: cf.id,
        name: slugify(cf.name),
        helpText: cf?.helpText || "",
        required: cf.required,
        type: cf.type.toLowerCase() as "text" | "number" | "date" | "boolean",
        options: cf.options,
      })),
    });

    const payload = parseData(formData, FormSchema);

    const customFieldsValues = extractCustomFieldValuesFromPayload({
      payload,
      customFieldDef: customFields,
    });

    const {
      title,
      description,
      category,
      qrId,
      newLocationId,
      valuation,
      addAnother,
    } = payload;

    /** This checks if tags are passed and build the  */
    const tags = buildTagsSet(payload.tags);

    /** Extract barcode data from form only if barcodes are enabled */
    const barcodes = canUseBarcodes
      ? extractBarcodesFromFormData(formData)
      : [];

    /**
     * BIG: `?kit=` lets the Kit page's "New asset" button create gear that
     * lands straight in that kit — previously this meant leaving the kit,
     * creating the asset, navigating back and adding it.
     *
     * The id comes from the URL, so it is proven to belong to the caller's
     * organization before it is connected.
     * @see .claude/rules/org-scope-user-supplied-ids.md
     */
    const requestedKitId = new URL(request.url).searchParams.get("kit");
    const kitId = requestedKitId
      ? (
          await db.kit.findFirst({
            where: { id: requestedKitId, organizationId },
            select: { id: true },
          })
        )?.id
      : undefined;

    // BIG: validated before anything is created — see resolveTargetBooking.
    const targetBooking = await resolveTargetBooking({
      request,
      organizationId,
    });

    const asset = await createAsset({
      organizationId,
      title,
      description,
      userId: authSession.userId,
      categoryId: category,
      locationId: newLocationId,
      qrId,
      kitId,
      tags,
      valuation,
      customFieldsValues,
      barcodes,
    });

    const actor = wrapUserLinkForNote({
      id: authSession.userId,
      firstName: asset.user.firstName,
      lastName: asset.user.lastName,
    });

    // Run independent post-creation tasks in parallel
    const postCreationTasks: Promise<unknown>[] = [
      updateAssetMainImage({
        request,
        assetId: asset.id,
        userId: authSession.userId,
        organizationId,
        isNewAsset: true,
      }),
      createNote({
        content: `Asset was created by ${actor}.`,
        type: "UPDATE",
        userId: authSession.userId,
        assetId: asset.id,
        organizationId,
      }),
    ];

    if (asset.location) {
      const locationLink = wrapLinkForNote(
        `/locations/${asset.location.id}`,
        asset.location.name.trim()
      );
      postCreationTasks.push(
        createNote({
          content: `${actor} set the location to ${locationLink}.`,
          type: "UPDATE",
          userId: authSession.userId,
          assetId: asset.id,
          organizationId,
        })
      );
    }

    await Promise.all(postCreationTasks);

    if (targetBooking) {
      try {
        // Same path as the booking's "Add equipment" picker, so conflict
        // handling, the booking note and the custodian email all match.
        await updateBookingAssets({
          id: targetBooking.id,
          organizationId,
          assetIds: [asset.id],
          userId: authSession.userId,
        });
        const bookingLink = wrapLinkForNote(
          `/bookings/${targetBooking.id}`,
          targetBooking.name
        );
        await createNote({
          content: `${actor} added asset to ${bookingLink}.`,
          type: "UPDATE",
          userId: authSession.userId,
          assetId: asset.id,
          organizationId,
        });
        void sendBookingUpdatedEmail({
          bookingId: targetBooking.id,
          organizationId,
          userId: authSession.userId,
          changes: [
            "Assets were added to the booking",
            "View booking activity for full details",
          ],
          hints: getClientHint(request),
        });

        sendNotification({
          title: "Asset created",
          message: `Added to "${targetBooking.name}".`,
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });
      } catch (cause) {
        // The asset exists; say so plainly and send them back to the booking,
        // rather than leaving them on the form where they might create it twice.
        Logger.error(
          new ShelfError({
            cause,
            message: "Created an asset but could not add it to its booking.",
            additionalData: { assetId: asset.id, bookingId: targetBooking.id },
            label: "Booking",
          })
        );
        sendNotification({
          title: "Asset created, but not added",
          message: `"${asset.title}" was created but couldn't be added to this booking. Add it with "Add equipment".`,
          icon: { name: "trash", variant: "error" },
          senderId: authSession.userId,
        });
      }

      /** Add another keeps the booking, so the next asset lands there too. */
      if (addAnother) {
        return redirectDocument(`/assets/new?booking=${targetBooking.id}`);
      }
      return redirect(`/bookings/${targetBooking.id}`);
    }

    sendNotification({
      title: "Asset created",
      message: "Your asset has been created successfully",
      icon: { name: "success", variant: "success" },
      senderId: authSession.userId,
    });

    /** If the user used the add-another button, we reload the document to reset the form */
    if (addAnother) {
      return redirectDocument(`/assets/new?`);
    }

    return redirect(`/assets`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function NewAssetPage() {
  const title = useAtomValue(dynamicTitleAtom);
  const { nextSequentialId, referer, targetBooking } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const qrId = searchParams.get("qrId");

  // Get category from URL params or use the default passed prop
  const categoryFromUrl = searchParams.get("category");
  /**
   * BIG: `?location=` pre-selects the location, so the Location page's "New
   * asset" button drops the new item straight onto that shelf. The value is a
   * plain default for the picker; the server validates whatever is submitted.
   */
  const locationFromUrl = searchParams.get("location");
  /**
   * BIG: `?booking=` and `?kit=` are read by the action from the POST URL, but
   * the form's default action (".") drops the query string. Forward them.
   */
  const destination = new URLSearchParams();
  for (const key of ["booking", "kit"]) {
    const value = searchParams.get(key);
    if (value) destination.set(key, value);
  }
  const formAction = destination.size ? `?${destination.toString()}` : ".";

  return (
    <div className="relative">
      <Header title={title ? title : "Untitled Asset"} />
      {targetBooking ? (
        <p
          role="status"
          className="mt-4 rounded border border-primary-200 bg-primary-25 px-4 py-3 text-sm text-gray-800"
        >
          This asset will be added to the booking{" "}
          <span className="font-semibold">{targetBooking.name}</span> when you
          save.
        </p>
      ) : null}
      <div>
        <AssetForm
          qrId={qrId}
          categoryId={categoryFromUrl}
          locationId={locationFromUrl}
          sequentialId={nextSequentialId}
          referer={referer}
          action={formAction}
        />
      </div>
    </div>
  );
}
