/**
 * Member Reservation Portal — `/reserve`
 *
 * The BIG "Member" self-service hub. Members (provisioned from Neon CRM) land
 * here on login — see the redirect in `home.tsx` — instead of the admin
 * dashboard, which they cannot read. Here they browse available equipment,
 * start a reservation, and see their current reservations. The sidebar exposes
 * this route only to the MEMBER role.
 *
 * A "reservation" reuses shelf's booking system: it is a `Booking` with the
 * member as custodian. The "Reserve" buttons route into the existing, tested
 * `/assets/$id/overview/create-new-booking` flow (asset pre-selected, date
 * picker, conflict detection, self-service custodian forced to self), so this
 * page adds a member-friendly browse surface without re-implementing booking.
 *
 * @see {@link file://./me.bookings.tsx} — the analogous "my bookings" scoping
 * @see {@link file://./assets.$assetId.overview.create-new-booking.tsx}
 */
import dayGridPlugin from "@fullcalendar/daygrid";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { AssetStatus, BookingStatus, OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Form, Link, redirect, useLoaderData } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { BookingStatusBadge } from "~/components/booking/booking-status-badge";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { Spinner } from "~/components/shared/spinner";
import { db } from "~/database/db.server";
import { getRoomAvailability } from "~/modules/big-member/service.server";
import calendarStyles from "~/styles/layout/calendar.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export function links() {
  return [{ rel: "stylesheet", href: calendarStyles }];
}

/**
 * Booking statuses that represent a member's "live" reservations — anything not
 * yet completed, cancelled, or archived. Ordered roughly by lifecycle stage.
 */
const ACTIVE_RESERVATION_STATUSES: BookingStatus[] = [
  BookingStatus.DRAFT,
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/** Equipment cards per catalog page. */
const EQUIPMENT_PER_PAGE = 24;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, role } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });

    // Member-only portal. Admins/owners are allowed in so staff can preview it;
    // other restricted roles (BASE / SELF_SERVICE) use the standard bookings UI.
    const isStaff =
      role === OrganizationRoles.ADMIN || role === OrganizationRoles.OWNER;
    if (role !== OrganizationRoles.MEMBER && !isStaff) {
      throw redirect("/bookings");
    }

    const url = new URL(request.url);
    const search = (url.searchParams.get("q") ?? "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

    // "Available to reserve" = bookable + not currently checked out/in custody.
    // Date-range conflicts are enforced later by the booking flow itself.
    const availableWhere = {
      organizationId,
      availableToBook: true,
      status: AssetStatus.AVAILABLE,
    };
    const equipmentWhere = {
      ...availableWhere,
      ...(search
        ? { title: { contains: search, mode: "insensitive" as const } }
        : {}),
    };

    // Every query is org-scoped, and reservations are scoped to the caller's own
    // `custodianUserId` (the session user id, not user input) — no cross-org or
    // cross-user exposure.
    const [reservations, availableCount, equipment, equipmentCount] =
      await Promise.all([
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
          },
          orderBy: { from: "asc" },
          take: 20,
        }),
        db.asset.count({ where: availableWhere }),
        db.asset.findMany({
          where: equipmentWhere,
          select: {
            id: true,
            title: true,
            category: { select: { name: true, color: true } },
          },
          orderBy: { title: "asc" },
          take: EQUIPMENT_PER_PAGE,
          skip: (page - 1) * EQUIPMENT_PER_PAGE,
        }),
        db.asset.count({ where: equipmentWhere }),
      ]);

    // Room availability powers the member dashboard calendar (rooms are a
    // BIG-custom bookable resource; each active booking that includes a room
    // marks it unavailable for that window).
    const roomAvailability = await getRoomAvailability({ organizationId });

    const totalPages = Math.max(
      1,
      Math.ceil(equipmentCount / EQUIPMENT_PER_PAGE)
    );

    const header: HeaderData = { title: "Reserve equipment" };

    return data(
      payload({
        header,
        reservations,
        availableCount,
        equipment,
        search,
        page,
        totalPages,
        roomEvents: roomAvailability.events,
        roomLegend: roomAvailability.legend,
      })
    );
  } catch (cause) {
    // A thrown redirect (e.g. the non-member gate above) is a `Response` — let
    // it propagate instead of turning it into an error page.
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
  name: "reserve",
};

/** Builds a `/reserve` query string, preserving the search term across pages. */
function reserveHref(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) {
    params.set("q", search);
  }
  params.set("page", String(page));
  return `/reserve?${params.toString()}`;
}

/**
 * Member reservation hub: browse + search available equipment (each item links
 * into the booking flow, pre-selected), plus the member's live reservations.
 */
export default function ReservePortal() {
  const {
    reservations,
    availableCount,
    equipment,
    search,
    page,
    totalPages,
    roomEvents,
    roomLegend,
  } = useLoaderData<typeof loader>();

  return (
    <div>
      <Header>
        <Button to="/bookings/new">New reservation</Button>
      </Header>

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

        {/* Room availability calendar */}
        <div className="mb-6 rounded border border-gray-200 bg-white p-4 md:p-6">
          <h2 className="text-sm font-semibold text-gray-900">
            Room availability
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Colored blocks show when a room is reserved — open slots are free to
            book.
          </p>

          {roomLegend.length === 0 ? (
            <p className="mt-4 text-sm text-gray-600">
              No rooms have been set up yet.
            </p>
          ) : (
            <>
              {/* Color key: which color belongs to which room */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {roomLegend.map((room) => (
                  <span
                    key={room.id}
                    className="inline-flex items-center gap-1.5 text-xs text-gray-600"
                  >
                    <span
                      className="inline-block size-3 rounded-sm"
                      style={{ backgroundColor: room.color }}
                    />
                    {room.name}
                  </span>
                ))}
              </div>

              <div className="mt-4">
                {/* FullCalendar is client-only; render a spinner during hydration. */}
                <ClientOnly
                  fallback={
                    <div className="flex justify-center py-16">
                      <Spinner />
                    </div>
                  }
                >
                  {() => (
                    <FullCalendar
                      plugins={[dayGridPlugin, timeGridPlugin]}
                      initialView="dayGridMonth"
                      headerToolbar={{
                        left: "prev,next today",
                        center: "title",
                        right: "dayGridMonth,timeGridWeek",
                      }}
                      events={roomEvents}
                      height="auto"
                      firstDay={1}
                      timeZone="local"
                      nowIndicator
                      // Render reservations as solid colored bars (not dots) so a
                      // "room is booked" window reads at a glance.
                      eventDisplay="block"
                      dayMaxEvents={3}
                      eventTimeFormat={{
                        hour: "numeric",
                        minute: "2-digit",
                        meridiem: "short",
                      }}
                    />
                  )}
                </ClientOnly>
              </div>
            </>
          )}
        </div>

        {/* Browse + search available equipment */}
        <div className="mb-6 rounded border border-gray-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
            <h2 className="text-sm font-semibold text-gray-900">
              Available equipment
            </h2>
            <Form method="get" className="flex items-center gap-2">
              <input
                type="search"
                name="q"
                defaultValue={search}
                placeholder="Search equipment…"
                aria-label="Search available equipment"
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
                ? `No available equipment matches “${search}”.`
                : "No equipment is available to reserve right now."}
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
                    {item.category ? (
                      <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-gray-500">
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{
                            backgroundColor: item.category.color ?? "#9ca3af",
                          }}
                        />
                        {item.category.name}
                      </span>
                    ) : (
                      <span className="mt-1 block text-xs text-gray-400">
                        Uncategorized
                      </span>
                    )}
                  </div>
                  <Button
                    to={`/assets/${item.id}/overview/create-new-booking`}
                    variant="secondary"
                    size="sm"
                  >
                    Reserve
                  </Button>
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
                    to={reserveHref(search, page - 1)}
                    variant="secondary"
                    size="sm"
                  >
                    Previous
                  </Button>
                ) : null}
                {page < totalPages ? (
                  <Button
                    to={reserveHref(search, page + 1)}
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

        {/* The member's own reservations */}
        <div className="rounded border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold text-gray-900">
              Your reservations
            </h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {reservations.length}
            </span>
          </div>

          {reservations.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-gray-600">
                You don&apos;t have any reservations yet.
              </p>
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
                    <span className="truncate text-sm font-medium text-gray-900">
                      {reservation.name}
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
                      className="text-xs font-medium text-primary-700 hover:text-primary-800"
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
        </div>
      </div>
    </div>
  );
}
