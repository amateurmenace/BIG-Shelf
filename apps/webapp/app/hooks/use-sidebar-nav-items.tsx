import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  AlarmClockIcon,
  BellIcon,
  BoxesIcon,
  CalendarRangeIcon,
  ChartLineIcon,
  DoorOpenIcon,
  FileBarChartIcon,
  HomeIcon,
  MapPinIcon,
  MessageCircleIcon,
  Package,
  PackageOpenIcon,
  QrCodeIcon,
  ScanBarcodeIcon,
  SettingsIcon,
  TagsIcon,
  UndoDotIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useLoaderData } from "react-router";
import { UpgradeMessage } from "~/components/marketing/upgrade-message";
import When from "~/components/when/when";
import type { loader } from "~/routes/_layout+/_layout";
import { isPersonalOrg } from "~/utils/organization";
import { useCurrentOrganization } from "./use-current-organization";
import { useUserRoleHelper } from "./user-user-role-helper";

type BaseNavItem = {
  title: string;
  hidden?: boolean;
  Icon: LucideIcon;
  disabled?: boolean | { reason: ReactNode };
  badge?: {
    show: boolean;
    variant?: "unread";
  };
};

export type ChildNavItem = BaseNavItem & {
  type: "child";
  to: string;
  target?: string;
};

export type ParentNavItem = BaseNavItem & {
  type: "parent";
  children: Omit<ChildNavItem, "type" | "Icon">[];
};

type LabelNavItem = Omit<BaseNavItem, "Icon"> & {
  type: "label";
};

type ButtonNavItem = BaseNavItem & {
  type: "button";
  onClick: () => void;
};

export type NavItem =
  | ChildNavItem
  | ParentNavItem
  | LabelNavItem
  | ButtonNavItem;

export function useSidebarNavItems() {
  const { isAdmin, canUseBookings, subscription, unreadUpdatesCount } =
    useLoaderData<typeof loader>();
  const { isBaseOrSelfService, isMember } = useUserRoleHelper();
  const currentOrganization = useCurrentOrganization();
  const isPersonalOrganization = isPersonalOrg(currentOrganization);

  const bookingDisabled = useMemo(() => {
    if (canUseBookings) {
      return false;
    }

    return {
      reason: (
        <div>
          <h5>Disabled</h5>
          <p>
            Booking is a premium feature only available for Team workspaces.
          </p>

          <When truthy={!!subscription} fallback={<UpgradeMessage />}>
            <p>Please switch to your team workspace to access this feature.</p>
          </When>
        </div>
      ),
    };
  }, [canUseBookings, subscription]);

  const topMenuItems: NavItem[] = [
    {
      type: "child",
      title: "Admin Dashboard",
      to: "/admin-dashboard/users",
      Icon: ChartLineIcon,
      hidden: !isAdmin,
    },
    {
      type: "label",
      title: "Asset management",
    },
    {
      // BIG: the member portal nav — a focused set replacing the staff items
      // below. Members land on their own dashboard (home.tsx redirects) and
      // do everything from these four surfaces.
      type: "child",
      title: "Home",
      to: "/reserve",
      Icon: HomeIcon,
      hidden: !isMember,
    },
    {
      type: "child",
      title: "Reserve equipment",
      to: "/reserve/equipment",
      Icon: PackageOpenIcon,
      hidden: !isMember,
    },
    {
      type: "child",
      title: "Book a room",
      to: "/reserve/rooms",
      Icon: DoorOpenIcon,
      hidden: !isMember,
    },
    {
      type: "child",
      title: "My reservations",
      to: "/me/bookings",
      Icon: CalendarRangeIcon,
      hidden: !isMember,
    },
    {
      type: "child",
      title: "Home",
      to: "/home",
      Icon: HomeIcon,
      hidden: isBaseOrSelfService,
    },
    {
      type: "child",
      title: "Assets",
      to: "/assets",
      Icon: PackageOpenIcon,
      // BIG: members browse equipment through the portal catalog instead.
      hidden: isMember,
    },
    {
      type: "child",
      title: "Kits",
      to: "/kits",
      Icon: Package,
      hidden: isMember,
    },
    {
      type: "child",
      title: "Rooms",
      to: "/rooms",
      Icon: DoorOpenIcon,
      // BIG: members book rooms through the portal picker instead.
      hidden: isMember,
    },
    {
      type: "child",
      title: "Categories",
      to: "/categories",
      Icon: BoxesIcon,
      hidden: isBaseOrSelfService,
    },

    {
      type: "child",
      title: "Tags",
      to: "/tags",
      Icon: TagsIcon,
      hidden: isBaseOrSelfService,
    },
    {
      type: "child",
      title: "Locations",
      to: "/locations",
      Icon: MapPinIcon,
      hidden: isBaseOrSelfService,
    },
    {
      type: "parent",
      title: "Bookings",
      Icon: CalendarRangeIcon,
      disabled: bookingDisabled,
      // BIG: members manage reservations through the portal instead.
      hidden: isMember,
      children: [
        {
          title: "View Bookings",
          to: "/bookings",
          disabled: bookingDisabled,
        },
        {
          title: "Calendar",
          to: "/calendar",
          disabled: bookingDisabled,
        },
        {
          // BIG: printable 7-day digest (rooms, pickups, returns, overdue).
          title: "Week ahead",
          to: "/week-ahead",
          disabled: bookingDisabled,
          hidden: isBaseOrSelfService,
        },
        {
          // BIG: the 16:9 touch wallboard — open on the lobby screen.
          title: "Wallboard",
          to: "/kiosk",
          target: "_blank",
          disabled: bookingDisabled,
          hidden: isBaseOrSelfService,
        },
      ],
    },
    {
      type: "child",
      title: "Reminders",
      Icon: AlarmClockIcon,
      hidden: isBaseOrSelfService,
      to: "/reminders",
    },
    {
      type: "child",
      title: "Reports",
      Icon: FileBarChartIcon,
      hidden: isBaseOrSelfService,
      to: "/reports",
    },
    {
      type: "label",
      title: "Organization",
      hidden: isBaseOrSelfService,
    },
    {
      type: "parent",
      title: "Team",
      Icon: UsersRoundIcon,
      hidden: isBaseOrSelfService,
      children: [
        {
          title: "Users",
          to: "/settings/team/users",
          hidden: isPersonalOrganization,
        },
        {
          title: "Pending invites",
          to: "/settings/team/invites",
          hidden: isPersonalOrganization,
        },
        {
          title: "Non-registered members",
          to: "/settings/team/nrm",
        },
      ],
    },
    {
      type: "parent",
      title: "Workspace settings",
      Icon: SettingsIcon,
      hidden: isBaseOrSelfService,
      children: [
        {
          title: "General",
          to: "/settings/general",
        },
        {
          title: "Bookings",
          to: "/settings/bookings",
          hidden: isPersonalOrganization,
        },
        {
          title: "Custom fields",
          to: "/settings/custom-fields",
        },
        {
          // BIG: pooled consumables & accessories (cables, batteries, …).
          title: "Supplies",
          to: "/settings/supplies",
        },
        {
          // BIG: audits moved out of the top-level nav — they are an
          // occasional administrative chore, not a daily surface, so they live
          // with the other workspace-level settings.
          title: "Audits",
          to: "/audits",
        },
      ],
    },
  ];

  const bottomMenuItems: NavItem[] = [
    {
      type: "child",
      title: "Asset labels",
      to: `https://store.shelf.nu/?ref=shelf_webapp_sidebar`,
      Icon: QrCodeIcon,
      target: "_blank",
    },
    {
      type: "child",
      title: "QR Scanner",
      to: "/scanner",
      Icon: ScanBarcodeIcon,
    },
    {
      // BIG: the returns desk — scan gear back in and photograph any damage
      // before it goes on the shelf. Members never see it.
      type: "child",
      title: "Check in",
      to: "/check-in",
      Icon: UndoDotIcon,
      hidden: isBaseOrSelfService || isMember,
    },
    {
      type: "button",
      title: "Updates",
      Icon: BellIcon,
      badge: {
        show: (unreadUpdatesCount || 0) > 0,
        variant: "unread" as const,
      },
      onClick: () => {
        // This will be handled by the sidebar component with popover
      },
    },
    {
      type: "button",
      title: "Questions/Feedback",
      Icon: MessageCircleIcon,
      onClick: () => {
        // Handled by FeedbackNavItem in sidebar-nav.tsx
      },
    },
  ];

  return {
    topMenuItems: removeHiddenNavItems(topMenuItems),
    bottomMenuItems: removeHiddenNavItems(bottomMenuItems),
  };
}

function removeHiddenNavItems(navItems: NavItem[]) {
  return navItems
    .filter((item) => !item.hidden)
    .map((item) => {
      if (item.type === "parent") {
        return {
          ...item,
          children: item.children.filter((child) => !child.hidden),
        };
      }

      return item;
    });
}
