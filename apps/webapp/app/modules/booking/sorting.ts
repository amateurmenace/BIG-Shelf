/**
 * Booking sorting
 *
 * The single source of truth for how the bookings list can be ordered. Both
 * halves of the feature read from here:
 *
 * - the client picker (`BookingFilters` → `SortBy`) renders {@link BOOKING_SORTING_OPTIONS}
 * - the loader (`getBookingsFilterData`) runs the raw `?orderBy=` param through
 *   {@link resolveBookingOrderBy} before it reaches Prisma
 *
 * Keeping them together means a new sort option cannot be added to the UI
 * without also being accepted by the server (and vice versa).
 *
 * @see {@link file://./service.server.ts} — `getBookingsFilterData` / `getBookings`
 * @see {@link file://./../../components/booking/booking-filters.tsx}
 */
import type { Prisma } from "@prisma/client";

/** Sort direction, matching the `SortBy` component's vocabulary. */
export type BookingSortDirection = "asc" | "desc";

/**
 * Every field a booking list may be ordered by, mapped to its picker label.
 *
 * `createdAt` is first because it is the default: "most recent" is what people
 * mean when they open the bookings list without choosing a sort.
 */
export const BOOKING_SORTING_OPTIONS = {
  createdAt: "Date created",
  from: "Start date",
  to: "End date",
  name: "Name",
  status: "Status",
  updatedAt: "Last updated",
  custodian: "Reserved for",
} as const;

/** A key of {@link BOOKING_SORTING_OPTIONS}. */
export type BookingSortField = keyof typeof BOOKING_SORTING_OPTIONS;

/**
 * The default ordering for every bookings list: newest first.
 *
 * Previously the list defaulted to `from asc`, which buried a booking someone
 * had just created behind every historical one whose start date came earlier.
 */
export const DEFAULT_BOOKING_SORT_FIELD: BookingSortField = "createdAt";
export const DEFAULT_BOOKING_SORT_DIRECTION: BookingSortDirection = "desc";

/** Narrows an arbitrary string to a supported sort field. */
export function isBookingSortField(value: string): value is BookingSortField {
  return Object.prototype.hasOwnProperty.call(BOOKING_SORTING_OPTIONS, value);
}

/** Narrows an arbitrary string to a supported sort direction. */
export function isBookingSortDirection(
  value: string
): value is BookingSortDirection {
  return value === "asc" || value === "desc";
}

/**
 * Turns a user-supplied `?orderBy=`/`?orderDirection=` pair into a Prisma
 * `orderBy` clause.
 *
 * Unknown values fall back to the defaults rather than throwing — the params
 * are user-editable, and a bookmarked URL from an older build should still
 * render a list instead of a 500. This is also what keeps an arbitrary string
 * from reaching Prisma as a column name.
 *
 * `custodian` is special-cased: it is a relation, not a scalar, so it orders by
 * the custodian team member's name (`TeamMember.name` is non-nullable, so no
 * nulls-ordering hint is needed).
 *
 * @param orderBy - The raw `orderBy` search param.
 * @param orderDirection - The raw `orderDirection` search param.
 * @returns A Prisma `orderBy` clause for `booking.findMany`.
 */
export function resolveBookingOrderBy(
  orderBy: string | null | undefined,
  orderDirection: string | null | undefined
): Prisma.BookingOrderByWithRelationInput {
  const field: BookingSortField =
    orderBy && isBookingSortField(orderBy)
      ? orderBy
      : DEFAULT_BOOKING_SORT_FIELD;

  const direction: BookingSortDirection =
    orderDirection && isBookingSortDirection(orderDirection)
      ? orderDirection
      : DEFAULT_BOOKING_SORT_DIRECTION;

  if (field === "custodian") {
    return { custodianTeamMember: { name: direction } };
  }

  return { [field]: direction };
}
