/**
 * Room calendar (admin) — `/settings/room-calendar`
 *
 * BIG-only. Connects room bookings to a shared **Google Calendar** so the whole
 * team sees the studio schedule inside Google Workspace. Once configured, every
 * reserve / date change / room change / cancel is pushed automatically by the
 * booking-service hooks; this page shows the connection status, walks an admin
 * through the one-time Google setup when unconfigured, and offers a manual
 * "Sync calendar now" reconcile (push all active room bookings + prune stale
 * upcoming events).
 *
 * Gated on `generalSettings` (ADMIN/OWNER) in a TEAM workspace — rooms and the
 * shared calendar are team infrastructure, so personal workspaces get a 403
 * (their auto-created owners must not trigger calendar traffic).
 *
 * @see {@link file://./../../modules/big-room-calendar/service.server.ts}
 * @see {@link file://./../../integrations/google-calendar/client.server.ts}
 */
import { BookingStatus } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import {
  getServiceAccountEmail,
  isGoogleCalendarConfigured,
} from "~/integrations/google-calendar/client.server";
import {
  resyncRoomCalendar,
  type RoomCalendarResyncResult,
} from "~/modules/big-room-calendar/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { GOOGLE_ROOM_CALENDAR_ID } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Rooms + the shared calendar are TEAM infrastructure. Personal workspaces
 * (every self-signed member owns one as OWNER) must not reach the sync.
 *
 * @throws {ShelfError} 403 when the selected workspace isn't a TEAM org
 */
function assertTeamWorkspace(organizationType: string): void {
  if (organizationType !== "TEAM") {
    throw new ShelfError({
      cause: null,
      title: "Not available in this workspace",
      message:
        "The room calendar is only available to admins of a team workspace.",
      label: "Room Calendar",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });
    assertTeamWorkspace(currentOrganization.type);

    // Status color for the page: how many room reservations are being mirrored.
    const [roomCount, activeRoomBookings] = await Promise.all([
      db.room.count({ where: { organizationId } }),
      db.booking.count({
        where: {
          organizationId,
          status: {
            in: [
              BookingStatus.RESERVED,
              BookingStatus.ONGOING,
              BookingStatus.OVERDUE,
            ],
          },
          rooms: { some: {} },
        },
      }),
    ]);

    return payload({
      title: "Room calendar",
      configured: isGoogleCalendarConfigured(),
      saEmail: getServiceAccountEmail(),
      calendarId: GOOGLE_ROOM_CALENDAR_ID ?? "",
      roomCount,
      activeRoomBookings,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });
    assertTeamWorkspace(currentOrganization.type);

    // One intent: reconcile (push all active room bookings, prune stale).
    const synced: RoomCalendarResyncResult = await resyncRoomCalendar({
      organizationId,
    });
    return payload({ synced });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.title) },
];

export const handle = { name: "settings.room-calendar" };

export default function RoomCalendarSettings() {
  const { configured, saEmail, calendarId, roomCount, activeRoomBookings } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const disabled = useDisabled();

  const synced =
    actionData && "synced" in actionData ? actionData.synced : undefined;
  const errorMessage =
    actionData && "error" in actionData ? actionData.error?.message : undefined;

  return (
    <div className="mb-2.5 flex flex-col gap-4 rounded border border-gray-200 bg-white px-6 py-5">
      <div>
        <h3 className="text-text-lg font-semibold">Room calendar</h3>
        <p className="mt-1 text-sm text-gray-600">
          Mirror room reservations onto a shared Google Calendar so the whole
          team sees the studio schedule in Google Workspace. Once connected,
          reservations appear, move, and disappear automatically — color-coded
          per room.
        </p>
      </div>

      {configured ? (
        <div className="flex flex-col gap-4">
          {/* Status + action card */}
          <div className="flex flex-col gap-4 rounded border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <span className="text-3xl font-semibold tabular-nums text-gray-900">
                {activeRoomBookings}
              </span>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-700">
                  active room reservation{activeRoomBookings === 1 ? "" : "s"}{" "}
                  kept in sync
                </span>
                <span className="text-xs text-gray-500">
                  {roomCount} room{roomCount === 1 ? "" : "s"} ·{" "}
                  <a
                    href={`https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(
                      calendarId
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    open in Google Calendar
                  </a>
                </span>
              </div>
            </div>
            <Form method="post">
              <Button type="submit" disabled={disabled}>
                {disabled ? "Syncing…" : "Sync calendar now"}
              </Button>
            </Form>
          </div>

          {synced ? (
            <p className="text-sm font-medium text-success-600">
              Calendar reconciled — {synced.synced} event
              {synced.synced === 1 ? "" : "s"} pushed
              {synced.pruned > 0
                ? `, ${synced.pruned} stale event${
                    synced.pruned === 1 ? "" : "s"
                  } removed`
                : ""}
              .
            </p>
          ) : null}

          <p className="text-xs text-gray-500">
            New reservations push automatically the moment they happen. Use
            &quot;Sync calendar now&quot; after changing the configuration or if
            the calendar ever looks out of step.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded border border-[#FFE082] bg-[#FFF8E1] px-4 py-3 text-sm text-gray-700">
            Not connected yet — a one-time Google setup (~10 minutes) is needed.
          </div>

          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-gray-700">
            <li>
              In{" "}
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Google Cloud Console
              </a>
              , create (or pick) a project and enable the{" "}
              <span className="font-medium">Google Calendar API</span>.
            </li>
            <li>
              Create a <span className="font-medium">service account</span> (IAM
              &amp; Admin → Service Accounts) and download a{" "}
              <span className="font-medium">JSON key</span> for it.
            </li>
            <li>
              In Google Calendar, create a calendar (e.g.{" "}
              <span className="font-medium">BIG Room Bookings</span>), share it
              with{" "}
              {saEmail ? (
                <code className="rounded bg-gray-100 px-1">{saEmail}</code>
              ) : (
                "the service-account email"
              )}{" "}
              with{" "}
              <span className="font-medium">
                &quot;Make changes to events&quot;
              </span>
              , and copy its <span className="font-medium">Calendar ID</span>{" "}
              (calendar Settings → Integrate calendar). Then share the calendar
              with the team.
            </li>
            <li>
              Set the Fly secrets:{" "}
              <code className="rounded bg-gray-100 px-1">
                GOOGLE_CALENDAR_SA_EMAIL
              </code>
              ,{" "}
              <code className="rounded bg-gray-100 px-1">
                GOOGLE_CALENDAR_SA_PRIVATE_KEY
              </code>{" "}
              (the <code>private_key</code> from the JSON key) and{" "}
              <code className="rounded bg-gray-100 px-1">
                GOOGLE_ROOM_CALENDAR_ID
              </code>
              , then redeploy and press &quot;Sync calendar now&quot; here.
            </li>
          </ol>
        </div>
      )}

      {errorMessage ? (
        <p className="text-sm text-error-500">{errorMessage}</p>
      ) : null}
    </div>
  );
}
