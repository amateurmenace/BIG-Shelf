/**
 * Manage-booking tab bar
 *
 * The four ways to put something on a booking — Equipment, Kits, Rooms,
 * Supplies — presented as one tab strip so they read as a single picker rather
 * than four unrelated buttons.
 *
 * BIG: rooms and supplies were previously reachable only from separate buttons
 * on the booking page, so people did not realise a room reservation and an
 * equipment reservation were the same booking. Everything a booking can contain
 * now lives behind one set of tabs.
 *
 * Each tab is a route under `bookings/:id/overview/`; switching tabs navigates.
 * The caller owns the unsaved-changes guard, because only it knows whether its
 * own selection has been touched.
 *
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.manage-assets.tsx}
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.manage-kits.tsx}
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.manage-rooms.tsx}
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.manage-supplies.tsx}
 */
import { TabsList, TabsTrigger } from "~/components/shared/tabs";
import { GrayBadge } from "../shared/gray-badge";

/** The tabs, in display order, with the route each one navigates to. */
export const MANAGE_BOOKING_TABS = [
  { value: "assets", label: "Equipment", segment: "manage-assets" },
  { value: "kits", label: "Kits", segment: "manage-kits" },
  { value: "rooms", label: "Rooms", segment: "manage-rooms" },
  { value: "supplies", label: "Supplies", segment: "manage-supplies" },
] as const;

/** A tab's `value`. */
export type ManageBookingTab = (typeof MANAGE_BOOKING_TABS)[number]["value"];

/**
 * Maps a tab value to the URL to navigate to.
 *
 * @param tab - The tab being switched to.
 * @param bookingId - The booking whose picker is open.
 * @param search - Optional query string to carry across (e.g. the booking
 *   window params the asset picker needs to compute availability).
 */
export function manageBookingTabUrl(
  tab: ManageBookingTab,
  bookingId: string,
  search?: string
) {
  const entry = MANAGE_BOOKING_TABS.find((item) => item.value === tab);
  const base = `/bookings/${bookingId}/overview/${
    entry?.segment ?? "manage-assets"
  }`;
  return search ? `${base}?${search}` : base;
}

/**
 * Renders the tab strip.
 *
 * Must be rendered inside a Radix `<Tabs>` whose `value` is the active tab and
 * whose `onValueChange` navigates (see {@link manageBookingTabUrl}).
 *
 * @param counts - Per-tab selection counts; a tab with a count > 0 shows a badge.
 */
export function ManageBookingTabs({
  counts,
}: {
  counts?: Partial<Record<ManageBookingTab, number>>;
}) {
  return (
    <div className="border-b px-6 py-2">
      <TabsList className="w-full">
        {MANAGE_BOOKING_TABS.map((tab) => {
          const count = counts?.[tab.value] ?? 0;
          return (
            <TabsTrigger
              key={tab.value}
              className="flex-1 gap-x-2"
              value={tab.value}
              aria-label={`${tab.label} tab${
                count > 0 ? ` (${count} selected)` : ""
              }`}
            >
              {tab.label}
              {count > 0 ? (
                <GrayBadge className="size-[20px] border border-primary-200 bg-primary-50 text-[10px] leading-[10px] text-primary-700">
                  {count}
                </GrayBadge>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}
