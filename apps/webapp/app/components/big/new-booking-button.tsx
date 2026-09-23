/**
 * New booking button
 *
 * BIG: sits in the top right of every page — the desktop header row and the
 * mobile top bar — where upstream's "Quick find" button was, so starting a
 * booking is always one click away. Quick find itself is unchanged and still
 * opens with ⌘K / Ctrl K: that shortcut belongs to the command palette, not to
 * the button this replaces.
 *
 * Staff go to the booking form; members, who book through their portal
 * (equipment or a room), go to /reserve. Hidden for anyone who cannot create
 * bookings, and on pages that already offer one (the bookings list) or are the
 * new-booking page itself.
 *
 * @see {@link file://./../layout/header/index.tsx}
 * @see {@link file://./../../routes/_layout+/_layout.tsx}
 */
import { CalendarPlusIcon } from "lucide-react";
import { useMatches } from "react-router";
import { Button } from "~/components/shared/button";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import type { RouteHandleWithName } from "~/modules/types";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";

/** Route handles where the button would be redundant. */
const HIDDEN_ON_ROUTES = ["bookings.new", "bookings.index"];

/**
 * @param props.variant - `default` (labelled, desktop header) or `icon`
 *   (compact, mobile top bar).
 * @param props.className - Extra classes for the button.
 */
export function NewBookingButton({
  variant = "default",
  className,
}: {
  variant?: "default" | "icon";
  className?: string;
}) {
  const matches = useMatches();
  const currentRoute: RouteHandleWithName = matches[matches.length - 1];
  const { roles, isBaseOrSelfService } = useUserRoleHelper();

  const canCreateBookings = userHasPermission({
    roles,
    entity: PermissionEntity.booking,
    action: PermissionAction.create,
  });

  if (
    !canCreateBookings ||
    HIDDEN_ON_ROUTES.includes(currentRoute?.handle?.name ?? "")
  ) {
    return null;
  }

  // Members book through their own portal.
  const to = isBaseOrSelfService ? "/reserve" : "/bookings/new";

  if (variant === "icon") {
    return (
      <Button
        to={to}
        variant="secondary"
        aria-label="New booking"
        title="New booking"
        className={tw(
          "flex items-center justify-center rounded border-0 bg-white px-2 py-[2px] text-gray-600 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2",
          className
        )}
      >
        <CalendarPlusIcon className="size-5" aria-hidden />
      </Button>
    );
  }

  return (
    <Button to={to} icon="plus" className={tw("whitespace-nowrap", className)}>
      New booking
    </Button>
  );
}
