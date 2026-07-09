/**
 * Staff Room Booking Form — `/rooms/:roomId/book`
 *
 * The staff twin of the member booking page: same shared form + one-step
 * create-and-reserve pipeline, but with a "Reserve for" custodian picker so
 * staff can book on any team member's behalf, and with full schedule detail
 * (booking names + custodians) in the day panel.
 *
 * Restricted roles (MEMBER/SELF_SERVICE/BASE) can technically reach this page
 * (the section requires only `room:read`); for them the picker collapses to
 * themself and the server enforces self-custody — so there is no privilege
 * gap, they just get the member experience.
 *
 * Named `rooms.$roomId_.book` (trailing underscore) so it renders as a full
 * page rather than inside the room detail's `<Outlet/>`, mirroring
 * `rooms.$roomId_.edit`.
 *
 * @see {@link file://./reserve.rooms.$roomId.tsx} — the member twin
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
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Route params schema — the room ID comes from the URL and is untrusted. */
const paramsSchema = z.object({ roomId: z.string() });

/**
 * Loads the room with a detailed 60-day schedule (staff see names), the
 * custodian options, and timezone-correct default times.
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId, isSelfServiceOrBase } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.create,
    });

    const [rooms, teamMembersData, bookingSettings] = await Promise.all([
      getRoomsWithSchedule({
        organizationId,
        roomId,
        horizonDays: 60,
        // Staff see who holds each slot; restricted roles get anonymized data.
        includeDetails: !isSelfServiceOrBase,
      }),
      getTeamMemberForForm({
        organizationId,
        userId,
        isSelfServiceOrBase,
        getAll: true,
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

    const custodianOptions: CustodianOption[] = teamMembersData.teamMembers.map(
      (teamMember) => ({
        id: teamMember.id,
        name: teamMember.name,
        userId: teamMember.userId ?? null,
      })
    );

    if (custodianOptions.length === 0) {
      throw new ShelfError({
        cause: null,
        title: "No team members",
        message:
          "There is no team member to hold this reservation. Add team members first.",
        additionalData: { userId, organizationId },
        status: 400,
        label: "Booking",
        shouldBeCaptured: false,
      });
    }

    // Preselect the caller's own record when they have one.
    const selfOption = custodianOptions.find(
      (option) => option.userId === userId
    );

    const bufferHours = isSelfServiceOrBase
      ? bookingSettings.bufferStartTime
      : 0;
    const start = DateTime.now()
      .setZone(getHints(request).timeZone)
      .plus({ hours: bufferHours + 1 })
      .startOf("hour");

    const header: HeaderData = { title: `Book ${room.name}` };

    return data(
      payload({
        header,
        room,
        custodianOptions,
        defaultCustodianId: (selfOption ?? custodianOptions[0]).id,
        defaultStart: toDateTimeLocalValue(start),
        defaultEnd: toDateTimeLocalValue(start.plus({ hours: 2 })),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, roomId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Creates + reserves the room booking. Staff land on the booking page to
 * fine-tune (add gear, tags, notes); restricted roles go to the member
 * dashboard confirmation.
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { roomId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId, currentOrganization, isSelfServiceOrBase } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.create,
      });

    // SECURITY: mirror bookings.new — no bookings in personal workspaces.
    if (isPersonalOrg(currentOrganization)) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message:
          "You can't create bookings for personal workspaces. Please create a Team workspace to create bookings.",
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

    const booking = await createRoomReservation({
      organizationId,
      roomId,
      ...parsed,
      creatorId: userId,
      hints: getClientHint(request),
      isSelfServiceOrBase,
    });

    sendNotification({
      title: "Room reserved",
      message: "The room reservation is confirmed.",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return redirect(
      isSelfServiceOrBase ? "/reserve?booked=1" : `/bookings/${booking.id}`
    );
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
  name: "rooms.book",
};

/**
 * The staff booking page: shared form (custodian select visible) + room card.
 */
export default function StaffRoomBookingPage() {
  const {
    room,
    custodianOptions,
    defaultCustodianId,
    defaultStart,
    defaultEnd,
  } = useLoaderData<typeof loader>();

  return (
    <div>
      <Header />

      <div className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-[1fr,360px]">
        <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
          <RoomBookingForm
            room={room}
            busyWindows={room.busyWindows}
            defaultStart={defaultStart}
            defaultEnd={defaultEnd}
            custodian={{
              kind: "select",
              options: custodianOptions,
              defaultId: defaultCustodianId,
            }}
            submitLabel="Reserve room"
          />
          <p className="mt-3 text-xs text-gray-500">
            The reservation is created as Reserved — you&apos;ll land on its
            booking page to add extra gear, tags, or notes.
          </p>
        </div>

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
              <p className="text-xs text-gray-500">
                {room.assetCount} piece{room.assetCount === 1 ? "" : "s"} of
                equipment ride along with this room.
              </p>
            </div>
          </div>

          <Link
            to={`/rooms/${room.id}`}
            className="text-sm font-medium text-primary-700 hover:text-primary-800"
          >
            ← Room details
          </Link>
        </div>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
