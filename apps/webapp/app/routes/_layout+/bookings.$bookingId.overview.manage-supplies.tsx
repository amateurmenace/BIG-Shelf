/**
 * Manage supplies modal route (booking overview)
 *
 * The drawer behind the booking page's "Add supplies" button. Renders the
 * {@link SupplyWizard} — one step per supply category — and writes the whole
 * basket back in a single action.
 *
 * Supplies are pooled by quantity rather than tracked as individual assets, so
 * there is no per-unit selection here: the wizard is steppers, and availability
 * is arithmetic over the booking's own window.
 *
 * Gated on `booking / manageAssets`, the same permission as the asset and room
 * pickers — anyone allowed to change what a booking contains may change its
 * supplies.
 *
 * @see {@link file://./../../modules/big-supply/service.server.ts}
 * @see {@link file://./../../components/big/supply/supply-wizard.tsx}
 * @see {@link file://./bookings.$bookingId.overview.manage-rooms.tsx} — the room picker this mirrors
 */
import { BookingStatus } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect, useLoaderData, useNavigate } from "react-router";
import { z } from "zod";
import { SupplyWizard } from "~/components/big/supply/supply-wizard";
import {
  ManageBookingTabs,
  manageBookingTabUrl,
  type ManageBookingTab,
} from "~/components/booking/manage-booking-tabs";
import { Button } from "~/components/shared/button";
import { Tabs } from "~/components/shared/tabs";
import {
  getSuppliesWithAvailability,
  setBookingSupplies,
} from "~/modules/big-supply/service.server";
import { SUPPLY_INTENT, SupplyBasketSchema } from "~/modules/big-supply/shared";
import { getBooking } from "~/modules/booking/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const meta = () => [{ title: appendToMetaTitle("Manage supplies") }];

/**
 * Booking statuses whose contents are still editable.
 *
 * Mirrors the asset picker: once a booking is finished, cancelled or archived,
 * its record of what went out must not be rewritten.
 */
const EDITABLE_STATUSES: BookingStatus[] = [
  BookingStatus.DRAFT,
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.manageAssets,
    });

    const booking = await getBooking({
      id: bookingId,
      organizationId,
      request,
    });

    if (!EDITABLE_STATUSES.includes(booking.status)) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message:
          "You can only change the supplies on a booking that has not been completed yet.",
        additionalData: { bookingId, status: booking.status },
        shouldBeCaptured: false,
        label: "Booking",
      });
    }

    const supplies = await getSuppliesWithAvailability({
      organizationId,
      from: booking.from,
      to: booking.to,
      excludeBookingId: bookingId,
    });

    return payload({
      showSidebar: true,
      header: {
        title: `Add supplies to '${booking.name}'`,
        subHeading:
          "Cables, batteries, adapters and other accessories. These are counted rather than individually tracked, so just say how many you need.",
      },
      booking: { id: booking.id, name: booking.name },
      noScroll: true,
      supplies,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, bookingId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.manageAssets,
    });

    const formData = await request.formData();

    if (formData.get("intent") !== SUPPLY_INTENT.saveBasket) {
      throw new ShelfError({
        cause: null,
        message: "Unsupported action.",
        additionalData: { bookingId },
        status: 400,
        shouldBeCaptured: false,
        label: "Booking",
      });
    }

    const { supplyBasket } = parseData(formData, SupplyBasketSchema, {
      additionalData: { userId, bookingId, organizationId },
    });

    // Every supplyId here came from the client; `setBookingSupplies` proves
    // each one belongs to this organization before it is written.
    await setBookingSupplies({
      bookingId,
      organizationId,
      lines: supplyBasket,
    });

    return redirect(`/bookings/${bookingId}/overview`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, bookingId });
    return data(error(reason), { status: reason.status });
  }
}

export default function ManageSupplies() {
  const { booking, supplies } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const selectedUnits = supplies.reduce(
    (sum, supply) => sum + supply.quantityOnThisBooking,
    0
  );

  return (
    <Tabs
      className="flex h-full max-h-full flex-col"
      value="supplies"
      activationMode="manual"
      onValueChange={(value) => {
        // BIG: supplies are one tab of the single "add to this booking" picker.
        void navigate(
          manageBookingTabUrl(value as ManageBookingTab, booking.id)
        );
      }}
    >
      <ManageBookingTabs counts={{ supplies: selectedUnits }} />
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <SupplyWizard supplies={supplies} />
        <div className="mt-3 flex justify-start">
          <Button
            variant="link-gray"
            type="button"
            onClick={() => navigate("..")}
            className="text-sm"
          >
            Cancel
          </Button>
        </div>
      </div>
    </Tabs>
  );
}
