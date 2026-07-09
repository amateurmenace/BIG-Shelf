/**
 * Member Home Dashboard — `/reserve`
 *
 * The landing page for BIG members, sharing the kiosk wallboard's content and
 * interaction patterns restyled for the light in-app theme (members are
 * mostly on phones): a warm greeting, the admin-authored rotating news
 * banner, two big actions ("Reserve equipment" / "Book a room"), an
 * interactive 7-day room schedule whose free slots deep-link into the booking
 * form with the time prefilled, the member's upcoming reservations, the
 * kiosk's class/event promos as tappable links, and an embedded month/week
 * availability calendar with closed days shaded.
 *
 * PRIVACY: every schedule surface is anonymized — members see WHEN rooms are
 * taken, never WHO booked them (`getRoomsWithSchedule` without
 * `includeDetails`, `getRoomAvailability`).
 *
 * Members arrive here on login via the `home.tsx` MEMBER redirect. The
 * equipment catalog and the room booking flow live on sibling routes:
 *
 * @see {@link file://./reserve.tsx} — the section layout + shared gate
 * @see {@link file://./reserve.equipment.tsx} — browse + reserve equipment
 * @see {@link file://./reserve.rooms._index.tsx} — the room picker
 * @see {@link file://./reserve.rooms.$roomId.tsx} — the booking form (?start= prefill)
 * @see {@link file://./../kiosk.tsx} — the dark wallboard twin of this page
 * @see {@link file://./../../modules/big-kiosk-content/service.server.ts} — news/promos/closed days
 */
import { AssetStatus, BookingStatus } from "@prisma/client";
import { DoorOpenIcon, VideoIcon } from "lucide-react";
import { DateTime } from "luxon";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { MemberNewsBanner } from "~/components/big/reserve/news-banner";
import { PromoCardLink } from "~/components/big/reserve/promo-card-link";
import { DayScheduleBoard } from "~/components/big/room-booking/day-schedule-board";
import { RoomAvailabilityCalendar } from "~/components/big/room-booking/room-availability-calendar";
import { BookingStatusBadge } from "~/components/booking/booking-status-badge";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { db } from "~/database/db.server";
import { useSearchParams } from "~/hooks/search-params";
import {
  getKioskClosedDays,
  getKioskConfig,
  getKioskPromos,
  splitKioskNews,
} from "~/modules/big-kiosk-content/service.server";
import {
  getRoomAvailability,
  requireMemberPortalAccess,
} from "~/modules/big-member/service.server";
import { getRoomsWithSchedule } from "~/modules/big-room-booking/service.server";
import { getMemberWaitlist } from "~/modules/big-waitlist/service.server";
import calendarStyles from "~/styles/layout/calendar.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getHints } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";

export function links() {
  return [{ rel: "stylesheet", href: calendarStyles }];
}

/** Statuses that count as a "live" reservation for the Coming up list. */
const ACTIVE_RESERVATION_STATUSES: BookingStatus[] = [
  BookingStatus.DRAFT,
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/**
 * Loads everything the dashboard shows: greeting inputs, action-card counts,
 * the member's next reservations, waitlist size, room schedules for the
 * interactive board, and the kiosk's shared content (news lines, promos,
 * closed days). All queries are org-scoped; reservations/waitlist are
 * additionally scoped to the caller's own user id.
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

    // Time-of-day greeting, computed in the viewer's timezone server-side so
    // SSR and hydration agree.
    const hour = DateTime.now().setZone(getHints(request).timeZone).hour;
    const greeting =
      hour < 12
        ? "Good morning"
        : hour < 18
        ? "Good afternoon"
        : "Good evening";

    const [
      user,
      availableCount,
      reservations,
      totalReservations,
      rooms,
      waitlist,
      promos,
      kioskConfig,
      closedDays,
    ] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { firstName: true },
      }),
      db.asset.count({
        where: {
          organizationId,
          availableToBook: true,
          status: AssetStatus.AVAILABLE,
        },
      }),
      db.booking.findMany({
        where: {
          organizationId,
          custodianUserId: userId,
          status: { in: ACTIVE_RESERVATION_STATUSES },
        },
        select: {
          id: true,
          name: true,
          from: true,
          to: true,
          status: true,
          custodianUserId: true,
          rooms: { select: { id: true, name: true, color: true } },
        },
        orderBy: { from: "asc" },
        take: 5,
      }),
      db.booking.count({
        where: {
          organizationId,
          custodianUserId: userId,
          status: { in: ACTIVE_RESERVATION_STATUSES },
        },
      }),
      // Anonymized: no booking/custodian names reach the member's browser.
      getRoomsWithSchedule({ organizationId, horizonDays: 7 }),
      getMemberWaitlist({ organizationId, userId }),
      // The kiosk's admin-managed content, shared with the member dashboard.
      getKioskPromos({ organizationId }),
      getKioskConfig({ organizationId }),
      getKioskClosedDays({ organizationId }),
    ]);

    // Events for the embedded month/week calendar (also anonymized).
    const roomAvailability = await getRoomAvailability({ organizationId });

    const freeNowCount = rooms.filter(
      (room) => room.availability.state === "free"
    ).length;
    const waitlistCount = waitlist.filter(
      (entry) => String(entry.status) === "WAITING"
    ).length;

    const header: HeaderData = { title: "Member home" };

    return data(
      payload({
        header,
        greeting,
        firstName: user?.firstName ?? null,
        availableCount,
        reservations,
        totalReservations,
        rooms,
        freeNowCount,
        waitlistCount,
        roomEvents: roomAvailability.events,
        // Tight-mapped: only what the promo cards render.
        promos: promos.map((promo) => ({
          id: promo.id,
          title: promo.title,
          eventDate: promo.eventDate,
          linkUrl: promo.linkUrl,
          imageUrl: promo.imageUrl,
        })),
        newsMessages: splitKioskNews(kioskConfig?.newsMessages),
        closedDays,
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

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  name: "reserve.index",
};

/**
 * The dashboard: news banner, greeting hero, action cards, the interactive
 * day-schedule board, coming-up list, promo cards, waitlist teaser, and the
 * embedded availability calendar.
 */
export default function MemberHomeDashboard() {
  const {
    greeting,
    firstName,
    availableCount,
    reservations,
    totalReservations,
    rooms,
    freeNowCount,
    waitlistCount,
    roomEvents,
    promos,
    newsMessages,
    closedDays,
  } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const justBooked = searchParams.get("booked") === "1";

  return (
    <div>
      <Header> </Header>

      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        {justBooked ? (
          <div
            role="status"
            className="rounded border border-success-200 bg-success-50 p-3 text-sm text-success-700"
          >
            <span className="font-medium">Room reserved!</span> You&apos;ll find
            it under &ldquo;Coming up&rdquo; below, and a confirmation email is
            on its way.
          </div>
        ) : null}

        {/* Rotating news banner — same admin-authored lines as the kiosk */}
        <MemberNewsBanner messages={newsMessages} />

        {/* Greeting hero */}
        <div className="rounded-lg border border-gray-200 bg-gradient-to-r from-primary-25 to-white p-5 md:p-6">
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
            {greeting}
            {firstName ? `, ${firstName}` : ""}!
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            What would you like to do today?
          </p>
        </div>

        {/* The two big actions */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Link
            to="/reserve/equipment"
            className="group flex items-start gap-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition hover:border-primary-300 hover:shadow-md"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <VideoIcon className="size-6" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold text-gray-900 group-hover:text-primary-700">
                Reserve equipment
              </span>
              <span className="mt-1 block text-sm text-gray-600">
                {availableCount} item{availableCount === 1 ? " is" : "s are"}{" "}
                ready to borrow — cameras, audio, lighting and more.
              </span>
            </span>
          </Link>

          <Link
            to="/reserve/rooms"
            className="group flex items-start gap-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition hover:border-blue-300 hover:shadow-md"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <DoorOpenIcon className="size-6" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold text-gray-900 group-hover:text-blue-700">
                Book a room
              </span>
              <span className="mt-1 block text-sm text-gray-600">
                {rooms.length === 0
                  ? "Studios and edit suites, reservable by the hour."
                  : `${freeNowCount} of ${rooms.length} room${
                      rooms.length === 1 ? " is" : "s are"
                    } free right now.`}
              </span>
            </span>
          </Link>
        </div>

        {/* Coming up */}
        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold text-gray-900">Coming up</h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {totalReservations}
            </span>
          </div>

          {reservations.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-600">
              Nothing booked yet — reserve equipment or book a room above.
            </div>
          ) : (
            <ul>
              {reservations.map((reservation) => (
                <li
                  key={reservation.id}
                  className="flex items-center justify-between gap-4 border-b border-gray-100 px-4 py-3 last:border-b-0 md:px-6"
                >
                  <Link
                    to={`/bookings/${reservation.id}`}
                    className="flex min-w-0 flex-col hover:underline"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {reservation.rooms.map((room) => (
                        <span
                          key={room.id}
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: room.color ?? "#6b7280" }}
                          title={room.name}
                          aria-hidden
                        />
                      ))}
                      <span className="truncate text-sm font-medium text-gray-900">
                        {reservation.name}
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">
                      <DateS date={reservation.from} includeTime />
                      {" – "}
                      <DateS date={reservation.to} includeTime />
                    </span>
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link
                      to={`/loan-agreement/${reservation.id}`}
                      className="hidden text-xs font-medium text-primary-700 hover:text-primary-800 sm:block"
                    >
                      Loan agreement
                    </Link>
                    <BookingStatusBadge
                      status={reservation.status}
                      custodianUserId={reservation.custodianUserId ?? undefined}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {totalReservations > reservations.length ? (
            <div className="border-t border-gray-100 px-4 py-3 md:px-6">
              <Button to="/me/bookings" variant="link">
                View all {totalReservations} reservations
              </Button>
            </div>
          ) : null}
        </div>

        {/* Classes & events — the kiosk promos as tappable sign-up links */}
        {promos.length > 0 ? (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">
              Classes &amp; events
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {promos.map((promo) => (
                <PromoCardLink key={promo.id} promo={promo} />
              ))}
            </div>
          </div>
        ) : null}

        {/* Waitlist teaser */}
        {waitlistCount > 0 ? (
          <Link
            to="/reserve/equipment"
            className="block rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm transition hover:border-primary-300 md:px-6"
          >
            You&apos;re on {waitlistCount} waitlist
            {waitlistCount === 1 ? "" : "s"} — we&apos;ll email you the moment
            those items free up.{" "}
            <span className="font-medium text-primary-700">Manage</span>
          </Link>
        ) : null}

        {/* Interactive room schedule — the kiosk board, app-styled. Free slots
            deep-link into the booking form with the time prefilled. Placed lower
            so the member's own content (reservations, classes) leads the page. */}
        {rooms.length > 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-gray-900">
                Book a room by time
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                Pick a day, then tap any open slot to start a reservation.
              </p>
            </div>
            <ClientOnly
              fallback={
                <div className="h-48 animate-pulse rounded-lg bg-gray-100" />
              }
            >
              {() => <DayScheduleBoard rooms={rooms} closedDays={closedDays} />}
            </ClientOnly>
          </div>
        ) : null}

        {/* Embedded availability calendar (month/week + closed-day shading) */}
        {rooms.length > 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-gray-900">
                Room availability
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                Colored blocks show when a room is reserved — open slots are
                free to book. Red-shaded days are when BIG is closed.
              </p>
            </div>
            <RoomAvailabilityCalendar
              rooms={rooms}
              events={roomEvents}
              closedDays={closedDays}
            />
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            No rooms have been set up yet.
          </p>
        )}
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
