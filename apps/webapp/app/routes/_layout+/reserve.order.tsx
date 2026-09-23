/**
 * Member Order Checkout — `/reserve/order`
 *
 * Reviews the scan-to-reserve cart and books everything in one reservation:
 * the items (with thumbnails + remove), a pickup/return window with one-tap
 * duration presets, and a single "Reserve" submit. Mobile-first.
 *
 * The cart itself lives client-side (localStorage atom) — the action
 * re-validates every id server-side (org ownership + bookability) and then
 * composes upstream booking services via {@link createEquipmentReservation},
 * so the Neon membership gate, asset-conflict validation, working-hours /
 * buffer policies (via the shared {@link parseRoomBookingForm}), confirmation
 * email, and loan-agreement checkout gate all keep applying.
 *
 * Submits over a fetcher (not a document POST) so the client can clear the
 * cart atom on success before navigating home to the confirmation banner.
 *
 * @see {@link file://./reserve.scan.tsx} — how items get scanned in
 * @see {@link file://./../../atoms/big-equipment-order.ts} — the cart atom
 * @see {@link file://./../../modules/big-equipment/service.server.ts}
 */
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { BookingStatus } from "@prisma/client";
import { useAtom } from "jotai";
import { PackageIcon, ScanLineIcon, Trash2Icon } from "lucide-react";
import { DateTime } from "luxon";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Link,
  useFetcher,
  useLoaderData,
  useNavigate,
} from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { z } from "zod";
import { equipmentOrderAtom } from "~/atoms/big-equipment-order";
import { toDateTimeLocalValue } from "~/components/big/room-booking/schedule";
import type { BookingFormSchemaType } from "~/components/booking/forms/forms-schema";
import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import { createEquipmentReservation } from "~/modules/big-equipment/service.server";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { ensureMemberRecord } from "~/modules/big-member-directory/service.server";
import { parseRoomBookingForm } from "~/modules/big-room-booking/service.server";
import { getBookingSettingsForOrganization } from "~/modules/booking-settings/service.server";
import { getTeamMemberForForm } from "~/modules/team-member/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getClientHint, getHints } from "~/utils/client-hints";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import { error, parseData, payload } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import { PermissionAction } from "~/utils/permissions/permission.data";

/** One-tap loan lengths (equipment loans usually span days, not hours). */
const DURATION_PRESETS: { label: string; hours: number }[] = [
  { label: "4 hours", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
];

/** Sanity cap — an order bigger than this is almost certainly a mistake. */
const MAX_ORDER_ITEMS = 25;

/**
 * Loads what checkout needs: the member's own team-member record (the fixed
 * custodian) and hydration-safe default pickup/return times.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, isStaff } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const [teamMembersData, bookingSettings] = await Promise.all([
      // isSelfServiceOrBase=true returns exactly the caller's own record —
      // members always book as themselves on this surface.
      getTeamMemberForForm({
        organizationId,
        userId,
        isSelfServiceOrBase: true,
      }),
      getBookingSettingsForOrganization(organizationId),
    ]);

    // BIG: someone in the workspace without a team-member record gets one
    // now — taking over any account-less record staff booked for them —
    // instead of a dead end telling them to contact staff, who had no way to
    // fix it. Sign-up normally does this already; this is the backstop.
    const selfTeamMember =
      teamMembersData.teamMembers[0] ??
      (await ensureMemberRecord({ organizationId, userId }));

    /**
     * BIG: `?addTo=<bookingId>` is the "I also need equipment" path from a room
     * booking — the order is appended to that reservation instead of becoming a
     * second one. Scoped to the member's OWN bookings here so the form never
     * even renders for someone else's id; the write path re-checks.
     */
    const addToBookingId = new URL(request.url).searchParams.get("addTo");
    const attachTo = addToBookingId
      ? await db.booking.findFirst({
          where: {
            id: addToBookingId,
            organizationId,
            status: { in: [BookingStatus.DRAFT, BookingStatus.RESERVED] },
            OR: [
              { custodianUserId: userId },
              { custodianTeamMemberId: selfTeamMember.id },
            ],
          },
          select: { id: true, name: true, from: true, to: true },
        })
      : null;

    // Default: the next full hour clearing the org's start buffer, for 1 day.
    // When appending to an existing reservation, its own window wins — the
    // member is not choosing new dates, they are adding to a booked slot.
    const bufferHours = isStaff ? 0 : bookingSettings.bufferStartTime;
    const start = DateTime.now()
      .setZone(getHints(request).timeZone)
      .plus({ hours: bufferHours + 1 })
      .startOf("hour");

    const header: HeaderData = {
      title: attachTo ? `Add to '${attachTo.name}'` : "Your order",
    };

    return data(
      payload({
        header,
        custodian: {
          id: selfTeamMember.id,
          name: selfTeamMember.name,
          userId: selfTeamMember.userId ?? null,
        },
        attachTo,
        defaultStart: attachTo
          ? toDateTimeLocalValue(
              DateTime.fromJSDate(attachTo.from).setZone(
                getHints(request).timeZone
              )
            )
          : toDateTimeLocalValue(start),
        defaultEnd: attachTo
          ? toDateTimeLocalValue(
              DateTime.fromJSDate(attachTo.to).setZone(
                getHints(request).timeZone
              )
            )
          : toDateTimeLocalValue(start.plus({ hours: 24 })),
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
 * The cart ids arrive as a JSON array in a hidden field. Named
 * `orderAssetIds` (not `assetIds`) because the shared BookingFormSchema —
 * which also parses this form — declares its own optional `assetIds` array
 * field, and a string value under that name fails ITS validation.
 */
const AssetIdsSchema = z.object({
  /**
   * BIG: when present, the order is ADDED to this existing reservation instead
   * of becoming a new one — the "I also need equipment" path from a room
   * booking. `createEquipmentReservation` proves the booking is the member's
   * own before writing to it.
   */
  attachToBookingId: z.string().min(1).optional(),
  orderAssetIds: z.string().transform((raw, ctx) => {
    try {
      const parsed = z
        .array(z.string().min(1))
        .min(1, "Your order is empty")
        .max(MAX_ORDER_ITEMS)
        .parse(JSON.parse(raw));
      return parsed;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Your order looks invalid — remove items and re-add them.",
      });
      return z.NEVER;
    }
  }),
});

/**
 * Creates + reserves the whole order for the member. Validation failures
 * (dates, working hours, conflicts, membership) return an error payload the
 * form renders; success returns `{ ok: true }` so the client can clear the
 * cart and navigate to the confirmation banner.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization, isSelfServiceOrBase } =
      await requireMemberPortalAccess({
        userId,
        request,
        action: PermissionAction.create,
      });

    // SECURITY: mirror bookings.new — no reservations in personal workspaces.
    if (isPersonalOrg(currentOrganization)) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "You can't create reservations in a personal workspace.",
        label: "Booking",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const formData = await request.formData();
    const { orderAssetIds, attachToBookingId } = parseData(
      formData,
      AssetIdsSchema,
      {
        shouldBeCaptured: false,
        additionalData: { userId, organizationId },
      }
    );
    const parsed = await parseRoomBookingForm({
      request,
      formData,
      organizationId,
      userId,
      isSelfServiceOrBase,
    });

    await createEquipmentReservation({
      organizationId,
      assetIds: orderAssetIds,
      ...parsed,
      creatorId: userId,
      hints: getClientHint(request),
      isSelfServiceOrBase,
      attachToBookingId,
    });

    return data(payload({ ok: true as const }));
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
  breadcrumb: () => "single",
  name: "reserve.order",
};

/**
 * The checkout page (cart list + booking window form).
 */
export default function MemberOrderPage() {
  return (
    <div>
      <Header />
      <ClientOnly
        fallback={
          <div className="p-4 md:p-6">
            <div className="h-48 animate-pulse rounded-lg bg-gray-100" />
          </div>
        }
      >
        {() => <OrderCheckout />}
      </ClientOnly>
    </div>
  );
}

/** Client-only inner — the cart lives in localStorage. */
function OrderCheckout() {
  const { custodian, defaultStart, defaultEnd, attachTo } =
    useLoaderData<typeof loader>();
  const [order, setOrder] = useAtom(equipmentOrderAtom);
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const disabled = useDisabled(fetcher);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  const result = fetcher.data;
  /** Server-side validation fallback (client validation can be bypassed). */
  const validationErrors = getValidationErrors<BookingFormSchemaType>(
    result && "error" in result ? result.error : undefined
  );
  const topLevelError =
    result && "error" in result && result.error && !validationErrors
      ? result.error
      : null;

  // Success: clear the cart, then land on the dashboard confirmation banner.
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      result &&
      "ok" in result &&
      result.ok === true
    ) {
      setOrder([]);
      void navigate("/reserve?booked=order");
    }
  }, [fetcher.state, result, setOrder, navigate]);

  const assetIdsJson = useMemo(
    () => JSON.stringify(order.map((item) => item.id)),
    [order]
  );

  /** Applies a duration preset from the current start time. */
  function applyPreset(hours: number) {
    const start = DateTime.fromISO(startDate);
    if (!start.isValid) return;
    setEndDate(toDateTimeLocalValue(start.plus({ hours })));
  }

  if (order.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-4 md:p-6">
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <PackageIcon className="mx-auto size-10 text-gray-300" aria-hidden />
          <h2 className="mt-3 text-base font-semibold text-gray-900">
            Your order is empty
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Scan gear around the space or browse the catalog to add items.
          </p>
          <div className="mt-4 flex flex-col justify-center gap-2 sm:flex-row">
            <Button to="/reserve/scan" className="w-full sm:w-auto">
              <span className="inline-flex items-center gap-1.5">
                <ScanLineIcon className="size-4" aria-hidden />
                Scan to add
              </span>
            </Button>
            <Button
              to="/reserve/equipment"
              variant="secondary"
              className="w-full sm:w-auto"
            >
              Browse equipment
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:gap-6 md:p-6">
      {/* The items */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-5">
          <h2 className="text-sm font-semibold text-gray-900">
            {order.length} item{order.length === 1 ? "" : "s"} in your order
          </h2>
          <Link
            to="/reserve/scan"
            className="text-xs font-medium text-primary-700 hover:text-primary-800"
          >
            + Scan more
          </Link>
        </div>
        <ul>
          {order.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 border-b border-gray-100 px-4 py-2.5 last:border-b-0 md:px-5"
            >
              <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-100 bg-gray-50">
                {item.image ? (
                  <img
                    src={item.image}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <PackageIcon className="size-5 text-gray-300" aria-hidden />
                )}
              </div>
              <Link
                to={`/reserve/equipment/${item.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 hover:underline"
              >
                {item.title}
              </Link>
              <button
                type="button"
                onClick={() =>
                  setOrder((current) =>
                    current.filter((entry) => entry.id !== item.id)
                  )
                }
                aria-label={`Remove ${item.title} from your order`}
                className="rounded p-2 text-gray-400 transition hover:bg-gray-50 hover:text-error-600"
              >
                <Trash2Icon className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* The booking window */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-5">
        {topLevelError ? (
          <div
            role="alert"
            className="mb-4 rounded border border-error-200 bg-error-50 p-3 text-sm text-error-700"
          >
            <p className="font-medium">
              {topLevelError.title ?? "Couldn't reserve your order"}
            </p>
            <p>{topLevelError.message}</p>
          </div>
        ) : null}

        {attachTo ? (
          <div className="mb-4 rounded border border-primary-200 bg-primary-25 p-3 text-sm">
            <p className="font-medium text-gray-900">
              Adding to &ldquo;{attachTo.name}&rdquo;
            </p>
            <p className="text-gray-600">
              This equipment joins your existing reservation, so there is only
              one thing to collect and return. The dates below are that
              reservation&apos;s and cannot be changed here.
            </p>
          </div>
        ) : null}

        <fetcher.Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="orderAssetIds" value={assetIdsJson} />
          {attachTo ? (
            <input type="hidden" name="attachToBookingId" value={attachTo.id} />
          ) : null}
          {/* Members always book as themselves; re-validated server-side. */}
          <input
            type="hidden"
            name="custodian"
            value={JSON.stringify(custodian)}
          />

          <Input
            label="Reservation name"
            name="name"
            defaultValue="Equipment order"
            required
            error={validationErrors?.name?.message}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Pick up"
              type="datetime-local"
              name="startDate"
              value={startDate}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setStartDate(event.currentTarget.value)
              }
              required
              error={validationErrors?.startDate?.message}
            />
            <Input
              label="Return"
              type="datetime-local"
              name="endDate"
              value={endDate}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setEndDate(event.currentTarget.value)
              }
              required
              error={validationErrors?.endDate?.message}
            />
          </div>

          {/* One-tap loan lengths */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Quick duration:</span>
            {DURATION_PRESETS.map((preset) => (
              <Button
                key={preset.hours}
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => applyPreset(preset.hours)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <Input
            label="Notes (optional)"
            inputType="textarea"
            name="description"
            rows={3}
            placeholder="What's this reservation for?"
            error={validationErrors?.description?.message}
          />

          <Button type="submit" disabled={disabled} className="w-full">
            {disabled
              ? "Reserving…"
              : `Reserve ${order.length} item${order.length === 1 ? "" : "s"}`}
          </Button>
        </fetcher.Form>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
