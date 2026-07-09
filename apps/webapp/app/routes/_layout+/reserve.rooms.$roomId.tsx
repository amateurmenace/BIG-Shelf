/**
 * Member Room Booking Form — `/reserve/rooms/:roomId`
 *
 * Books a specific room as the signed-in member: pick a start/end (with
 * one-tap durations), see that day's existing reservations live, and reserve.
 * Submitting creates AND reserves the booking in one step via
 * {@link createRoomReservation} — which enforces the Neon membership gate,
 * hard-rejects double-booked rooms, pulls in the room's equipment, emails the
 * confirmation, and mirrors to the shared Google room calendar.
 *
 * The custodian is always the member themself (hidden field, re-validated
 * server-side). Staff previewing this page books for themself too — the staff
 * flow with a custodian picker lives at `/rooms/:roomId/book`.
 *
 * @see {@link file://./../../components/big/room-booking/room-booking-form.tsx} — the shared form
 * @see {@link file://./../../modules/big-room-booking/service.server.ts}
 */
import { DateTime } from "luxon";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, redirect, useLoaderData } from "react-router";
import { z } from "zod";
import type { CustodianOption } from "~/components/big/room-booking/room-booking-form";
import { RoomBookingForm } from "~/components/big/room-booking/room-booking-form";
import { RoomStatusChip } from "~/components/big/room-booking/room-status-chip";
import { toDateTimeLocalValue } from "~/components/big/room-booking/schedule";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { db } from "~/database/db.server";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import {
  createRoomReservation,
  getRoomsWithSchedule,
  parseRoomBookingForm,
} from "~/modules/big-room-booking/service.server";
import { getBookingSettingsForOrganization } from "~/modules/booking-settings/service.server";
import { getTeamMemberForForm } from "~/modules/team-member/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getClientHint, getHints } from "~/utils/client-hints";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import { PermissionAction } from "~/utils/permissions/permission.data";

/** Route params schema — the room ID comes from the URL and is untrusted. */
const paramsSchema = z.object({ roomId: z.string() });

/**
 * Loads the room (with anonymized 60-day schedule), its equipment list, the
 * member's own team-member record (the fixed custodian), and hydration-safe
 * default start/end times computed in the viewer's timezone.
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId, isStaff } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const [rooms, roomAssets, teamMembersData, bookingSettings] =
      await Promise.all([
        // Anonymized: members see when, never who.
        getRoomsWithSchedule({ organizationId, roomId, horizonDays: 60 }),
        db.asset.findMany({
          where: { organizationId, roomId },
          select: { id: true, title: true },
          orderBy: { title: "asc" },
        }),
        // isSelfServiceOrBase=true returns exactly the caller's own record —
        // members always book as themselves on this surface.
        getTeamMemberForForm({
          organizationId,
          userId,
          isSelfServiceOrBase: true,
        }),
        getBookingSettingsForOrganization(organizationId),
      ]);

    const room = rooms[0];
    if (!room) {
      throw new ShelfError({
        cause: null,
        title: "Room not found",
        message:
          "The room you are trying to book does not exist or you do not have permission to access it.",
        additionalData: { roomId, organizationId },
        status: 404,
        label: "Room",
        shouldBeCaptured: false,
      });
    }

    const selfTeamMember = teamMembersData.teamMembers[0];
    if (!selfTeamMember) {
      throw new ShelfError({
        cause: null,
        title: "Account not ready",
        message:
          "Your account isn't linked to a team member yet, so it can't hold reservations. Please contact staff.",
        additionalData: { userId, organizationId },
        status: 400,
        label: "Booking",
        shouldBeCaptured: false,
      });
    }

    const custodian: CustodianOption = {
      id: selfTeamMember.id,
      name: selfTeamMember.name,
      userId: selfTeamMember.userId ?? null,
    };

    // Default to the next full hour that clears the org's start-time buffer
    // (staff bypass the buffer, mirroring upstream booking rules).
    const bufferHours = isStaff ? 0 : bookingSettings.bufferStartTime;
    const start = DateTime.now()
      .setZone(getHints(request).timeZone)
      .plus({ hours: bufferHours + 1 })
      .startOf("hour");

    const header: HeaderData = { title: `Book ${room.name}` };

    return data(
      payload({
        header,
        room,
        roomAssets,
        custodian,
        defaultStart: toDateTimeLocalValue(start),
        defaultEnd: toDateTimeLocalValue(start.plus({ hours: 2 })),
      })
    );
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId, roomId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Creates + reserves the room booking for the member. Validation failures
 * (including the 409 room conflict and the Neon membership gate) return an
 * error payload the form renders; success redirects to the dashboard with a
 * confirmation banner.
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId, currentOrganization, isSelfServiceOrBase } =
      await requireMemberPortalAccess({
        userId,
        request,
        action: PermissionAction.create,
      });

    // SECURITY: mirror bookings.new — reservations cannot be created in
    // personal workspaces, and the loader-only UI restriction is not enough.
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
    const parsed = await parseRoomBookingForm({
      request,
      formData,
      organizationId,
      userId,
      isSelfServiceOrBase,
    });

    await createRoomReservation({
      organizationId,
      roomId,
      ...parsed,
      creatorId: userId,
      hints: getClientHint(request),
      isSelfServiceOrBase,
    });

    sendNotification({
      title: "Room reserved",
      message: "Your room reservation is confirmed.",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return redirect("/reserve?booked=1");
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId, roomId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => "single",
  name: "reserve.rooms.book",
};

/**
 * The booking page: the shared form on the left, the room's identity card
 * (status, description, included equipment) on the right.
 */
export default function MemberRoomBookingPage() {
  const { room, roomAssets, custodian, defaultStart, defaultEnd } =
    useLoaderData<typeof loader>();

  return (
    <div>
      <Header />

      <div className="grid grid-cols-1 gap-4 p-4 md:p-6 lg:grid-cols-[1fr,360px]">
        {/* The form */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
          <RoomBookingForm
            room={room}
            busyWindows={room.busyWindows}
            defaultStart={defaultStart}
            defaultEnd={defaultEnd}
            custodian={{ kind: "fixed", value: custodian }}
          />
        </div>

        {/* Room identity card */}
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div
              className="h-1.5 w-full"
              style={{ backgroundColor: room.color }}
              aria-hidden
            />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-base font-semibold text-gray-900">
                  {room.name}
                </h2>
                <RoomStatusChip
                  availability={room.availability}
                  className="shrink-0"
                />
              </div>
              {room.description ? (
                <p className="text-sm text-gray-600">{room.description}</p>
              ) : null}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Included equipment
                </h3>
                {roomAssets.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-600">
                    This room has no equipment attached.
                  </p>
                ) : (
                  <ul className="mt-1 list-inside list-disc text-sm text-gray-700">
                    {roomAssets.map((asset) => (
                      <li key={asset.id}>{asset.title}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  Reserving this room reserves its equipment for you too.
                </p>
              </div>
            </div>
          </div>

          <Link
            to="/reserve/rooms"
            className="text-sm font-medium text-primary-700 hover:text-primary-800"
          >
            ← All rooms
          </Link>
        </div>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
