/**
 * Dashboard quick actions
 *
 * BIG: the six things staff actually do at the desk, one click from the home
 * page. Before this, every one of them was two or three navigations deep —
 * booking someone in meant Bookings → New booking → form, and checking gear
 * back in meant finding the booking first.
 *
 * Ordered by how often they are needed on a normal day, not alphabetically:
 * checking equipment out and back in is the whole job; the reports and the
 * wallboard are occasional.
 *
 * @see {@link file://./../../routes/_layout+/home.tsx}
 */
import type { LucideIcon } from "lucide-react";
import {
  CalendarPlusIcon,
  ClipboardListIcon,
  MonitorIcon,
  PackagePlusIcon,
  ScanBarcodeIcon,
  UndoDotIcon,
} from "lucide-react";
import { Link } from "react-router";
import { tw } from "~/utils/tw";

/** One card in the grid. */
type QuickAction = {
  label: string;
  description: string;
  to: string;
  Icon: LucideIcon;
  /** Opens in a new tab — used for the lobby wallboard. */
  target?: string;
  /** Renders in the brand colour: the single most-used action. */
  primary?: boolean;
};

const ACTIONS: QuickAction[] = [
  {
    label: "New booking",
    description: "Reserve equipment or a room",
    to: "/bookings/new",
    Icon: CalendarPlusIcon,
    primary: true,
  },
  {
    label: "Check out",
    description: "Scan gear going out",
    to: "/scanner",
    Icon: ScanBarcodeIcon,
  },
  {
    label: "Check in",
    description: "Scan returns, flag damage",
    to: "/check-in",
    Icon: UndoDotIcon,
  },
  {
    label: "Add asset",
    description: "Put new equipment on the shelf",
    to: "/assets/new",
    Icon: PackagePlusIcon,
  },
  {
    label: "Week ahead",
    description: "Printable pickup & return sheet",
    to: "/week-ahead",
    Icon: ClipboardListIcon,
  },
  {
    label: "Wallboard",
    description: "Open the lobby screen",
    to: "/kiosk",
    Icon: MonitorIcon,
    target: "_blank",
  },
];

/** Renders the quick-action card grid. */
export default function QuickActions() {
  return (
    <section aria-label="Quick actions">
      <h2 className="mb-2 text-sm font-semibold text-gray-900">
        Quick actions
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {ACTIONS.map((action) => (
          <Link
            key={action.label}
            to={action.to}
            target={action.target}
            rel={action.target === "_blank" ? "noreferrer" : undefined}
            className={tw(
              "group flex flex-col gap-2 rounded border p-4 transition",
              action.primary
                ? "border-primary-200 bg-primary-25 hover:border-primary-400 hover:bg-primary-50"
                : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
            )}
          >
            <span
              className={tw(
                "flex size-9 items-center justify-center rounded-full",
                action.primary
                  ? "bg-primary-100 text-primary-700"
                  : "bg-gray-100 text-gray-600"
              )}
            >
              <action.Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="text-sm font-semibold text-gray-900">
              {action.label}
            </span>
            <span className="text-xs leading-snug text-gray-500">
              {action.description}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
