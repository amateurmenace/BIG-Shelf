/**
 * Member Room Picker — `/reserve/rooms`
 *
 * The dedicated "book a room" entry point for members: one card per room with
 * its live status ("Free until 3:00 PM"), a 7-day load strip, and a Book
 * button into the per-room booking form.
 *
 * Anonymized by construction: `getRoomsWithSchedule` is called WITHOUT
 * details, so no booking or member names reach the browser.
 *
 * @see {@link file://./reserve.rooms.$roomId.tsx} — the booking form this links to
 * @see {@link file://./../../components/big/room-booking/room-picker-grid.tsx}
 */
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { RoomPickerGrid } from "~/components/big/room-booking/room-picker-grid";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { getRoomsWithSchedule } from "~/modules/big-room-booking/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";

/**
 * Loads every room with its anonymized 7-day schedule.
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

    const rooms = await getRoomsWithSchedule({
      organizationId,
      horizonDays: 7,
    });

    const header: HeaderData = { title: "Book a room" };

    return data(payload({ header, rooms }));
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => <Link to="/reserve/rooms">Book a room</Link>,
  name: "reserve.rooms.index",
};

/**
 * The picker page.
 */
export default function MemberRoomPicker() {
  const { rooms } = useLoaderData<typeof loader>();

  return (
    <div>
      <Header />

      <div className="p-4 md:p-6">
        <div className="mb-6 rounded border border-gray-200 bg-white p-4 md:p-6">
          <span className="text-lg font-semibold text-gray-900">
            Book a room
          </span>
          <p className="text-sm text-gray-500">
            Pick a room to see its schedule and reserve a time. Booking a room
            includes the equipment that lives in it.
          </p>
        </div>

        <RoomPickerGrid
          rooms={rooms}
          bookPath={(roomId) => `/reserve/rooms/${roomId}`}
        />
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
