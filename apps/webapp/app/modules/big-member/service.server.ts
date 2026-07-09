/**
 * BIG Member — server helpers
 *
 * Business logic for the BIG "Member" role: the self-service equipment
 * reservation experience layered on top of shelf's booking system. Members are
 * provisioned from Neon CRM (see the upcoming `big-neon` module) and land on the
 * member reservation portal (`/reserve`) instead of the admin dashboard, which
 * they are not permitted to read.
 *
 * This module is additive (BIG-only) per BIG-FORK.md — it composes existing
 * upstream services rather than editing them, to keep upstream merges clean.
 *
 * @see {@link file://./../../routes/_layout+/reserve.tsx} — the member portal route
 * @see {@link file://./../../utils/roles.server.ts} — requirePermission / role resolution
 */
import { BookingStatus, OrganizationRoles } from "@prisma/client";
import { redirect } from "react-router";
import { db } from "~/database/db.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import type { PermissionAction } from "~/utils/permissions/permission.data";
import { PermissionEntity } from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Resolves the caller's role in their currently-selected organization WITHOUT
 * enforcing any permission.
 *
 * Unlike {@link requirePermission}, which throws a 403 `ShelfError` when a role
 * lacks the requested entity/action, this simply returns the role. Use it on
 * error/redirect paths — e.g. routing a MEMBER away from a page they cannot
 * read — where we need to know the role but must not throw.
 *
 * @param args.userId - The authenticated user's id
 * @param args.request - The incoming request (used to resolve the selected org)
 * @returns The user's primary role in the selected org, or `null` if it cannot be resolved
 */
export async function getCurrentOrganizationRole({
  userId,
  request,
}: {
  userId: string;
  request: Request;
}): Promise<OrganizationRoles | null> {
  const { organizationId, userOrganizations } = await getSelectedOrganization({
    userId,
    request,
  });

  const roles = userOrganizations.find(
    (userOrg) => userOrg.organization.id === organizationId
  )?.roles;

  return roles && roles.length > 0 ? roles[0] : null;
}

/**
 * True when the given role should use the member reservation portal as its home
 * surface. Currently only the MEMBER role; kept as a single-source-of-truth
 * helper so the check does not drift across call sites.
 *
 * @param role - The role to test (nullable for convenience at call sites)
 */
export function isMemberRole(role: OrganizationRoles | null): boolean {
  return role === OrganizationRoles.MEMBER;
}

/**
 * The shared gate for every member-portal route (`/reserve` and children).
 *
 * Enforces the `booking` permission for the requested action, then applies
 * the portal's audience rule: MEMBERs (the portal's audience) and
 * ADMIN/OWNER (staff previewing the member experience) may proceed; other
 * restricted roles (BASE / SELF_SERVICE) are redirected to the standard
 * bookings UI they already use.
 *
 * Centralized here so the rule cannot drift as portal sub-pages multiply
 * (dashboard, equipment catalog, room picker, room booking form).
 *
 * @param args.userId - The authenticated user
 * @param args.request - The incoming request
 * @param args.action - The booking permission to require (read for pages,
 *   create for booking actions)
 * @returns Everything `requirePermission` returns, plus `isStaff`
 * @throws {Response} A redirect to `/bookings` for non-portal roles
 * @throws {ShelfError} 403 when the booking permission is missing entirely
 */
export async function requireMemberPortalAccess({
  userId,
  request,
  action,
}: {
  userId: string;
  request: Request;
  action: PermissionAction;
}) {
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.booking,
    action,
  });

  const isStaff =
    permission.role === OrganizationRoles.ADMIN ||
    permission.role === OrganizationRoles.OWNER;

  if (permission.role !== OrganizationRoles.MEMBER && !isStaff) {
    throw redirect("/bookings");
  }

  return { ...permission, isStaff };
}

/** Fallback color for rooms that don't have one set. */
const DEFAULT_ROOM_COLOR = "#6b7280";

/** Booking statuses that make a room unavailable (an active reservation). */
const ROOM_BUSY_STATUSES: BookingStatus[] = [
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/**
 * A calendar event marking a room as reserved (unavailable) for a time window.
 *
 * PRIVACY: deliberately carries no booking name or custodian — members may see
 * WHEN a room is taken, never WHO booked it. Only the room's own name is
 * exposed (as the event title and in `extendedProps.roomName`).
 */
export type RoomAvailabilityEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  backgroundColor: string;
  borderColor: string;
  extendedProps: { roomName: string };
};

/**
 * Builds room-availability calendar data for the member dashboard: one event per
 * room reservation (an active booking that includes the room), plus a color
 * legend of all rooms. Members see when each room is unavailable; open slots are
 * free. Org-scoped.
 *
 * @param args.organizationId - The workspace to read rooms + bookings from
 * @returns `{ events, legend }` for the calendar and its color key
 */
export async function getRoomAvailability({
  organizationId,
}: {
  organizationId: string;
}): Promise<{
  events: RoomAvailabilityEvent[];
  legend: { id: string; name: string; color: string }[];
}> {
  const rooms = await db.room.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      color: true,
      bookings: {
        where: { status: { in: ROOM_BUSY_STATUSES } },
        // PRIVACY: no booking name/custodian — see RoomAvailabilityEvent.
        select: { id: true, from: true, to: true },
      },
    },
    orderBy: { name: "asc" },
  });

  const events: RoomAvailabilityEvent[] = rooms.flatMap((room) =>
    room.bookings.map((booking) => ({
      id: `${room.id}:${booking.id}`,
      title: room.name,
      start: booking.from,
      end: booking.to,
      backgroundColor: room.color ?? DEFAULT_ROOM_COLOR,
      borderColor: room.color ?? DEFAULT_ROOM_COLOR,
      extendedProps: { roomName: room.name },
    }))
  );

  const legend = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    color: room.color ?? DEFAULT_ROOM_COLOR,
  }));

  return { events, legend };
}
