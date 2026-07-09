/**
 * Week Ahead Digest — `/week-ahead`
 *
 * The staff "what's happening" page: the next 7 days at a glance — room
 * reservations, equipment going out, returns due, and the overdue list — in a
 * layout designed to be READ fast and PRINTED (the Print button + the
 * `@media print` rules below strip the app chrome so it lands cleanly on
 * paper for the front desk).
 *
 * Full detail on purpose: this surface is staff-only (gated on
 * `dashboard:read`, which members lack), so booking + member names are shown.
 * The public wallboard twin — anonymized, touch-first — lives at `/kiosk`.
 *
 * @see {@link file://./../kiosk.tsx} — the 16:9 wallboard twin
 * @see {@link file://./../../modules/big-room-booking/service.server.ts} — getWeekAheadDigest
 */
import { ExternalLinkIcon, PrinterIcon } from "lucide-react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { getWeekAheadDigest } from "~/modules/big-room-booking/service.server";
import type { DigestBooking } from "~/modules/big-room-booking/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getHints } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

/**
 * Print rules: hide the sidebar/app chrome, unlock the scroll container so
 * every page prints, and keep each day block on one page where possible.
 * Injected as a plain `<style>` text child (house pattern — react-doctor
 * flags dangerouslySetInnerHTML).
 */
const PRINT_STYLES = `
@media print {
  #navigation,
  #main-content > header,
  .no-print {
    display: none !important;
  }
  #main-content {
    height: auto !important;
    overflow: visible !important;
    padding: 0 !important;
    background: white !important;
  }
  .print-block {
    break-inside: avoid;
  }
  .print-header {
    display: block !important;
  }
  a {
    color: inherit !important;
    text-decoration: none !important;
  }
}
`;

/**
 * Loads the 7-day digest in the viewer's timezone, plus identity for the
 * print header.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      // Staff-only, same audience as the admin dashboard.
      entity: PermissionEntity.dashboard,
      action: PermissionAction.read,
    });

    const digest = await getWeekAheadDigest({
      organizationId,
      timeZone: getHints(request).timeZone,
    });

    const header: HeaderData = { title: "Week ahead" };

    return data(
      payload({
        header,
        digest,
        organizationName: currentOrganization.name,
        generatedAt: new Date(),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => <Link to="/week-ahead">Week ahead</Link>,
  name: "week-ahead",
};

/** Compact stat tile for the summary strip. */
function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "alert";
}) {
  return (
    <div className="print-block rounded border border-gray-200 bg-white p-4">
      <span
        className={tw(
          "text-3xl font-semibold",
          tone === "alert" && value > 0 ? "text-error-600" : "text-gray-900"
        )}
      >
        {value}
      </span>
      <p className="mt-1 text-xs text-gray-500">{label}</p>
    </div>
  );
}

/** One booking row within a day column. */
function DigestRow({
  booking,
  time,
}: {
  booking: DigestBooking;
  /** Which end of the booking this row narrates. */
  time: "from" | "to" | "range";
}) {
  return (
    <li className="py-1.5">
      <Link
        to={`/bookings/${booking.id}`}
        className="group flex min-w-0 items-baseline gap-2"
      >
        <span className="shrink-0 text-xs font-semibold tabular-nums text-gray-900">
          {time === "range" ? (
            <>
              <DateS date={booking.from} onlyTime />
              {" – "}
              <DateS date={booking.to} onlyTime />
            </>
          ) : (
            <DateS
              date={time === "from" ? booking.from : booking.to}
              onlyTime
            />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-gray-900 group-hover:underline">
            {booking.name}
          </span>
          <span className="block truncate text-xs text-gray-500">
            {booking.custodianName ?? "Unassigned"}
            {booking.assetCount > 0
              ? ` · ${booking.assetCount} item${
                  booking.assetCount === 1 ? "" : "s"
                }`
              : ""}
            {booking.rooms.length > 0
              ? ` · ${booking.rooms.map((room) => room.name).join(", ")}`
              : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** A titled column (Rooms / Going out / Due back) within a day block. */
function DayColumn({
  title,
  bookings,
  time,
  emptyText,
}: {
  title: string;
  bookings: DigestBooking[];
  time: "from" | "to" | "range";
  emptyText: string;
}) {
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
        {bookings.length > 0 ? (
          <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 text-xs font-medium normal-case text-gray-600">
            {bookings.length}
          </span>
        ) : null}
      </h4>
      {bookings.length === 0 ? (
        <p className="mt-1 text-xs text-gray-400">{emptyText}</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-50">
          {bookings.map((booking) => (
            <DigestRow
              key={`${booking.id}-${title}`}
              booking={booking}
              time={time}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The digest page.
 */
export default function WeekAheadPage() {
  const { digest, organizationName, generatedAt } =
    useLoaderData<typeof loader>();

  return (
    <div>
      <style>{PRINT_STYLES}</style>

      <div className="no-print">
        <Header>
          <Button to="/kiosk" target="_blank" variant="secondary">
            <span className="flex items-center gap-1.5">
              Wallboard
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </span>
          </Button>
          <Button type="button" onClick={() => window.print()}>
            <span className="flex items-center gap-1.5">
              <PrinterIcon className="size-4" aria-hidden />
              Print
            </span>
          </Button>
        </Header>
      </div>

      {/* Print-only masthead (hidden on screen, shown on paper) */}
      <div className="print-header hidden border-b border-gray-300 pb-2">
        <p className="text-lg font-semibold text-gray-900">
          {organizationName} — Week ahead
        </p>
        <p className="text-xs text-gray-500">
          <DateS
            date={digest.start}
            options={{ month: "short", day: "numeric" }}
          />
          {" – "}
          <DateS
            date={digest.end}
            options={{ month: "short", day: "numeric", year: "numeric" }}
          />
          {" · printed "}
          <DateS date={generatedAt} includeTime />
        </p>
      </div>

      <div className="flex flex-col gap-4 p-4 md:p-6 print:gap-3 print:p-0">
        {/* Summary strip */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 print:grid-cols-4 print:gap-2">
          <StatTile
            label="Room reservations"
            value={digest.totals.roomBookings}
          />
          <StatTile
            label="Equipment going out"
            value={digest.totals.departures}
          />
          <StatTile label="Returns due" value={digest.totals.returns} />
          <StatTile
            label="Overdue right now"
            value={digest.totals.overdue}
            tone="alert"
          />
        </div>

        {/* Overdue callout */}
        {digest.overdue.length > 0 ? (
          <div className="print-block rounded border border-error-200 bg-error-50 p-4">
            <h3 className="text-sm font-semibold text-error-700">
              Overdue — chase these first
            </h3>
            <ul className="mt-1 divide-y divide-error-100">
              {digest.overdue.map((booking) => (
                <li key={booking.id} className="py-1.5">
                  <Link
                    to={`/bookings/${booking.id}`}
                    className="flex min-w-0 items-baseline gap-2"
                  >
                    <span className="shrink-0 text-xs font-semibold text-error-700">
                      due{" "}
                      <DateS
                        date={booking.to}
                        options={{ month: "short", day: "numeric" }}
                      />
                    </span>
                    <span className="min-w-0 truncate text-sm text-gray-900">
                      {booking.name}
                      <span className="text-xs text-gray-500">
                        {" "}
                        · {booking.custodianName ?? "Unassigned"} ·{" "}
                        {booking.assetCount} item
                        {booking.assetCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* One block per day */}
        {digest.days.map((day, index) => {
          const isQuiet =
            day.roomBookings.length === 0 &&
            day.departures.length === 0 &&
            day.returns.length === 0;

          return (
            <div
              key={String(day.date)}
              className="print-block rounded border border-gray-200 bg-white"
            >
              <div className="flex items-baseline gap-2 border-b border-gray-100 px-4 py-3 md:px-6">
                <h3 className="text-sm font-semibold text-gray-900">
                  {index === 0 ? (
                    "Today"
                  ) : index === 1 ? (
                    "Tomorrow"
                  ) : (
                    <DateS date={day.date} options={{ weekday: "long" }} />
                  )}
                </h3>
                <span className="text-xs text-gray-500">
                  <DateS
                    date={day.date}
                    options={{ month: "short", day: "numeric" }}
                  />
                </span>
              </div>

              {isQuiet ? (
                <p className="px-4 py-3 text-sm text-gray-400 md:px-6">
                  Quiet day — nothing scheduled.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3 md:px-6">
                  <DayColumn
                    title="Rooms"
                    bookings={day.roomBookings}
                    time="range"
                    emptyText="No room reservations"
                  />
                  <DayColumn
                    title="Going out"
                    bookings={day.departures}
                    time="from"
                    emptyText="No pickups"
                  />
                  <DayColumn
                    title="Due back"
                    bookings={day.returns}
                    time="to"
                    emptyText="No returns"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
