/**
 * Supplies service
 *
 * Supplies are pooled consumables and accessories — cables, batteries,
 * adapters, gels, media. They are counted, not tracked individually, so
 * everything here is quantity arithmetic rather than per-unit status.
 *
 * Availability model: a supply's free count for a window is
 * `quantityTotal - SUM(quantity)` over every *active* booking that overlaps the
 * window. "Active" excludes DRAFT (work in progress), CANCELLED, COMPLETE and
 * ARCHIVED — the same statuses that block a room.
 *
 * Every query is org-scoped at the app layer: the tables carry a plain
 * `organizationId` column rather than relations into upstream models.
 *
 * @see {@link file://./shared.ts} — client-safe constants/schemas
 * @see {@link file://./../../routes/_layout+/settings.supplies.tsx}
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.manage-supplies.tsx}
 */
import type {
  Booking,
  Organization,
  Prisma,
  User,
  SupplyCategory,
} from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import type { SupplyBasketLine } from "./shared";
import { MAX_SUPPLY_QUANTITY } from "./shared";

const label = "Booking" as const;

/**
 * Booking statuses that hold supplies out of the pool.
 *
 * Mirrors `ROOM_BLOCKING_STATUSES`: a DRAFT is work-in-progress and reserves
 * nothing, and anything finished has given its supplies back.
 */
export const SUPPLY_BLOCKING_STATUSES: BookingStatus[] = [
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/** A supply plus the availability numbers a picker needs. */
export type SupplyWithAvailability = {
  id: string;
  name: string;
  description: string | null;
  category: SupplyCategory;
  quantityTotal: number;
  storageLocation: string | null;
  isConsumable: boolean;
  /** How many are committed to other bookings over the requested window. */
  reservedElsewhere: number;
  /** `quantityTotal - reservedElsewhere`, floored at 0. */
  available: number;
  /** How many THIS booking already takes (0 when not editing a booking). */
  quantityOnThisBooking: number;
};

/**
 * Lists a workspace's supplies with availability for a booking window.
 *
 * @param args.organizationId - Caller's organization.
 * @param args.from - Window start; omit to skip availability maths.
 * @param args.to - Window end; omit to skip availability maths.
 * @param args.excludeBookingId - The booking being edited. Its own quantities
 *   are reported separately in `quantityOnThisBooking` instead of counting
 *   against availability, so editing a booking does not make its own supplies
 *   look unavailable.
 * @param args.includeInactive - Include supplies retired from the picker.
 * @returns Supplies ordered by category then name.
 */
export async function getSuppliesWithAvailability({
  organizationId,
  from,
  to,
  excludeBookingId,
  includeInactive = false,
}: {
  organizationId: Organization["id"];
  from?: Date | null;
  to?: Date | null;
  excludeBookingId?: Booking["id"] | null;
  includeInactive?: boolean;
}): Promise<SupplyWithAvailability[]> {
  try {
    const supplies = await db.supply.findMany({
      where: {
        organizationId,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    if (supplies.length === 0) return [];

    /**
     * Which bookings currently hold supplies out of the pool.
     *
     * `BookingSupply.bookingId` is a plain FK (no Prisma relation into the
     * upstream Booking model — see the schema comment), so the overlap filter
     * is resolved here and applied as an id list. When no window is given we
     * fall back to "everything currently out", which is what the settings
     * screen wants.
     */
    const blockingBookings = await db.booking.findMany({
      where: {
        organizationId,
        status: { in: SUPPLY_BLOCKING_STATUSES },
        ...(from && to ? { from: { lt: to }, to: { gt: from } } : {}),
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
      select: { id: true },
    });

    const overlapWhere: Prisma.BookingSupplyWhereInput = {
      organizationId,
      bookingId: { in: blockingBookings.map((booking) => booking.id) },
    };

    const [committed, onThisBooking] = await Promise.all([
      db.bookingSupply.groupBy({
        by: ["supplyId"],
        where: overlapWhere,
        _sum: { quantity: true },
      }),
      excludeBookingId
        ? db.bookingSupply.findMany({
            where: { bookingId: excludeBookingId, organizationId },
            select: { supplyId: true, quantity: true },
          })
        : Promise.resolve([]),
    ]);

    const committedBySupply = new Map(
      committed.map((row) => [row.supplyId, row._sum.quantity ?? 0])
    );
    const ownBySupply = new Map(
      onThisBooking.map((row) => [row.supplyId, row.quantity])
    );

    return supplies.map((supply) => {
      const reservedElsewhere = committedBySupply.get(supply.id) ?? 0;
      return {
        id: supply.id,
        name: supply.name,
        description: supply.description,
        category: supply.category,
        quantityTotal: supply.quantityTotal,
        storageLocation: supply.storageLocation,
        isConsumable: supply.isConsumable,
        reservedElsewhere,
        available: Math.max(0, supply.quantityTotal - reservedElsewhere),
        quantityOnThisBooking: ownBySupply.get(supply.id) ?? 0,
      };
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not load supplies. Please try again.",
      additionalData: { organizationId },
      label,
    });
  }
}

/** The supplies attached to one booking, for display. */
export type BookingSupplyLine = {
  id: string;
  supplyId: string;
  name: string;
  category: SupplyCategory;
  quantity: number;
  isConsumable: boolean;
  storageLocation: string | null;
};

/**
 * Reads the supplies attached to a booking.
 *
 * @param args.bookingId - The booking.
 * @param args.organizationId - Caller's organization, for scoping.
 */
export async function getBookingSupplies({
  bookingId,
  organizationId,
}: {
  bookingId: Booking["id"];
  organizationId: Organization["id"];
}): Promise<BookingSupplyLine[]> {
  const rows = await db.bookingSupply.findMany({
    where: { bookingId, organizationId },
    include: {
      supply: {
        select: {
          id: true,
          name: true,
          category: true,
          isConsumable: true,
          storageLocation: true,
        },
      },
    },
    orderBy: [{ supply: { category: "asc" } }, { supply: { name: "asc" } }],
  });

  return rows.map((row) => ({
    id: row.id,
    supplyId: row.supplyId,
    name: row.supply.name,
    category: row.supply.category,
    quantity: row.quantity,
    isConsumable: row.supply.isConsumable,
    storageLocation: row.supply.storageLocation,
  }));
}

/**
 * Replaces a booking's supply lines with the wizard's basket.
 *
 * The whole basket is written in one transaction: lines with quantity 0 are
 * deleted, the rest upserted. Doing it as a replace (rather than a diff the
 * client computes) means a stale tab cannot silently double a quantity.
 *
 * Over-committing is rejected per line against live availability rather than
 * against whatever the client last saw, so two people filling baskets at once
 * cannot both take the last four cables.
 *
 * @param args.bookingId - The booking to write to.
 * @param args.organizationId - Caller's organization; every supply id supplied
 *   by the client is proven to belong to it before use.
 * @param args.lines - The basket: `{ supplyId, quantity }` per line.
 * @throws {ShelfError} 400 when a supply is not in the org, or when a line
 *   exceeds what is actually available for the booking's window.
 */
export async function setBookingSupplies({
  bookingId,
  organizationId,
  lines,
}: {
  bookingId: Booking["id"];
  organizationId: Organization["id"];
  lines: SupplyBasketLine[];
}) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, organizationId },
    select: { id: true, from: true, to: true },
  });

  if (!booking) {
    throw new ShelfError({
      cause: null,
      message: "Booking not found in this workspace.",
      additionalData: { bookingId, organizationId },
      status: 404,
      shouldBeCaptured: false,
      label,
    });
  }

  const wanted = lines.filter((line) => line.quantity > 0);

  if (wanted.some((line) => line.quantity > MAX_SUPPLY_QUANTITY)) {
    throw new ShelfError({
      cause: null,
      message: `You can add at most ${MAX_SUPPLY_QUANTITY} of any one supply.`,
      additionalData: { bookingId, organizationId },
      status: 400,
      shouldBeCaptured: false,
      label,
    });
  }

  /**
   * Org-scope every user-supplied id before it is written. The ids come
   * straight from the client, so an id from another workspace must not be
   * connectable here.
   * @see .claude/rules/org-scope-user-supplied-ids.md
   */
  const availability = await getSuppliesWithAvailability({
    organizationId,
    from: booking.from,
    to: booking.to,
    excludeBookingId: bookingId,
    includeInactive: true,
  });
  const byId = new Map(availability.map((supply) => [supply.id, supply]));

  for (const line of wanted) {
    const supply = byId.get(line.supplyId);
    if (!supply) {
      throw new ShelfError({
        cause: null,
        message:
          "One of the selected supplies is not available in this workspace.",
        additionalData: { bookingId, organizationId, supplyId: line.supplyId },
        status: 400,
        shouldBeCaptured: false,
        label,
      });
    }

    if (line.quantity > supply.available) {
      throw new ShelfError({
        cause: null,
        title: "Not enough available",
        message: `Only ${supply.available} × ${supply.name} ${
          supply.available === 1 ? "is" : "are"
        } free for these dates — someone else has the rest. Reduce the quantity or pick different dates.`,
        additionalData: { bookingId, organizationId, supplyId: supply.id },
        status: 400,
        shouldBeCaptured: false,
        label,
      });
    }
  }

  const keepIds = wanted.map((line) => line.supplyId);

  return db.$transaction(async (tx) => {
    await tx.bookingSupply.deleteMany({
      where: {
        bookingId,
        organizationId,
        ...(keepIds.length > 0 ? { supplyId: { notIn: keepIds } } : {}),
      },
    });

    for (const line of wanted) {
      await tx.bookingSupply.upsert({
        where: { bookingId_supplyId: { bookingId, supplyId: line.supplyId } },
        create: {
          bookingId,
          supplyId: line.supplyId,
          organizationId,
          quantity: line.quantity,
        },
        update: { quantity: line.quantity },
      });
    }

    return tx.bookingSupply.count({ where: { bookingId, organizationId } });
  });
}

/** Payload for creating or updating a supply type. */
export type SupplyInput = {
  name: string;
  description?: string;
  category: SupplyCategory;
  quantityTotal: number;
  storageLocation?: string;
  isConsumable: boolean;
};

/**
 * Creates a supply type.
 *
 * @throws {ShelfError} 409 when a supply with that name already exists in the
 *   workspace (the `(organizationId, name)` unique index).
 */
export async function createSupply({
  organizationId,
  userId,
  input,
}: {
  organizationId: Organization["id"];
  userId: User["id"];
  input: SupplyInput;
}) {
  try {
    return await db.supply.create({
      data: {
        organizationId,
        createdById: userId,
        name: input.name,
        description: input.description || null,
        category: input.category,
        quantityTotal: input.quantityTotal,
        storageLocation: input.storageLocation || null,
        isConsumable: input.isConsumable,
      },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      title: "Could not add supply",
      message: `A supply called “${input.name}” may already exist in this workspace. Try a different name.`,
      additionalData: { organizationId, name: input.name },
      status: 409,
      shouldBeCaptured: false,
      label,
    });
  }
}

/**
 * Updates a supply type.
 *
 * @param args.supplyId - The supply to update; proven in-org by the `where`.
 */
export async function updateSupply({
  supplyId,
  organizationId,
  input,
}: {
  supplyId: string;
  organizationId: Organization["id"];
  input: SupplyInput;
}) {
  const existing = await db.supply.findFirst({
    where: { id: supplyId, organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new ShelfError({
      cause: null,
      message: "That supply does not exist in this workspace.",
      additionalData: { supplyId, organizationId },
      status: 404,
      shouldBeCaptured: false,
      label,
    });
  }

  return db.supply.update({
    // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: the findFirst({ where: { id: supplyId, organizationId } }) guard above proves this id belongs to the caller's organization; this is the write on that same proven id
    where: { id: supplyId },
    data: {
      name: input.name,
      description: input.description || null,
      category: input.category,
      quantityTotal: input.quantityTotal,
      storageLocation: input.storageLocation || null,
      isConsumable: input.isConsumable,
    },
  });
}

/**
 * Retires or restores a supply.
 *
 * Retiring hides it from pickers but keeps every past `BookingSupply` row, so
 * the usage report stays honest about what was used last season.
 */
export async function setSupplyActive({
  supplyId,
  organizationId,
  active,
}: {
  supplyId: string;
  organizationId: Organization["id"];
  active: boolean;
}) {
  const existing = await db.supply.findFirst({
    where: { id: supplyId, organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new ShelfError({
      cause: null,
      message: "That supply does not exist in this workspace.",
      additionalData: { supplyId, organizationId },
      status: 404,
      shouldBeCaptured: false,
      label,
    });
  }

  // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: the findFirst({ where: { id: supplyId, organizationId } }) guard above proves this id belongs to the caller's organization; this is the write on that same proven id
  return db.supply.update({ where: { id: supplyId }, data: { active } });
}

/** One row of the supply usage report. */
export type SupplyUsageRow = {
  supplyId: string;
  name: string;
  category: SupplyCategory;
  quantityTotal: number;
  isConsumable: boolean;
  /** Number of bookings that included this supply in the window. */
  bookingCount: number;
  /** Total units taken across those bookings. */
  unitsUsed: number;
  /** Highest simultaneous commitment seen — the real "do we own enough?" number. */
  peakConcurrent: number;
  /** `peakConcurrent / quantityTotal` as a percentage, 0 when none are owned. */
  peakUtilization: number;
};

/**
 * Builds the supply usage report for a timeframe.
 *
 * `peakConcurrent` is computed with a sweep over the booking windows rather
 * than by summing: three bookings that each take four cables in different weeks
 * need four cables, not twelve. Summing would tell you to buy eight you do not
 * need, which is exactly the decision this report exists to inform.
 *
 * @param args.organizationId - Caller's organization.
 * @param args.from - Window start (inclusive).
 * @param args.to - Window end (exclusive).
 * @returns Rows ordered by units used, busiest first.
 */
export async function getSupplyUsageReport({
  organizationId,
  from,
  to,
}: {
  organizationId: Organization["id"];
  from: Date;
  to: Date;
}): Promise<{
  rows: SupplyUsageRow[];
  totals: {
    distinctSupplies: number;
    unitsUsed: number;
    bookingsWithSupplies: number;
  };
}> {
  /**
   * Bookings in the window that actually happened (or are happening). Drafts
   * never reserved anything and cancellations were given back, so counting
   * either would overstate demand — the opposite of useful when the report is
   * being used to decide what to buy.
   *
   * Resolved as an id list because `BookingSupply.bookingId` is a plain FK.
   */
  const windowBookings = await db.booking.findMany({
    where: {
      organizationId,
      status: { notIn: [BookingStatus.DRAFT, BookingStatus.CANCELLED] },
      from: { lt: to },
      to: { gt: from },
    },
    select: { id: true, from: true, to: true },
  });

  const bookingWindows = new Map(
    windowBookings.map((booking) => [
      booking.id,
      { from: booking.from, to: booking.to },
    ])
  );

  const rows = await db.bookingSupply.findMany({
    where: {
      organizationId,
      bookingId: { in: windowBookings.map((booking) => booking.id) },
    },
    select: {
      quantity: true,
      bookingId: true,
      supplyId: true,
      supply: {
        select: {
          id: true,
          name: true,
          category: true,
          quantityTotal: true,
          isConsumable: true,
        },
      },
    },
  });

  /** The subset of Supply fields the sweep below needs. */
  type ReportSupply = {
    id: string;
    name: string;
    category: SupplyCategory;
    quantityTotal: number;
    isConsumable: boolean;
  };

  /** supplyId → accumulator */
  const bySupply = new Map<
    string,
    {
      supply: ReportSupply;
      bookingIds: Set<string>;
      unitsUsed: number;
      /** Sweep events: +qty at window start, -qty at window end. */
      events: { at: number; delta: number }[];
    }
  >();

  const bookingsWithSupplies = new Set<string>();

  for (const row of rows) {
    const window = bookingWindows.get(row.bookingId);
    // Defensive: the id list above guarantees a hit, but a booking deleted
    // between the two queries would otherwise crash the report.
    if (!window) continue;

    bookingsWithSupplies.add(row.bookingId);

    let entry = bySupply.get(row.supplyId);
    if (!entry) {
      entry = {
        supply: row.supply,
        bookingIds: new Set(),
        unitsUsed: 0,
        events: [],
      };
      bySupply.set(row.supplyId, entry);
    }

    entry.bookingIds.add(row.bookingId);
    entry.unitsUsed += row.quantity;
    entry.events.push({ at: window.from.getTime(), delta: row.quantity });
    entry.events.push({ at: window.to.getTime(), delta: -row.quantity });
  }

  const result: SupplyUsageRow[] = [...bySupply.values()].map((entry) => {
    // Sweep: sort by time, applying ends (-) before starts (+) at the same
    // instant so a back-to-back handover is not counted as an overlap.
    const events = entry.events.sort(
      (a, b) => a.at - b.at || a.delta - b.delta
    );
    let running = 0;
    let peak = 0;
    for (const event of events) {
      running += event.delta;
      if (running > peak) peak = running;
    }

    return {
      supplyId: entry.supply.id,
      name: entry.supply.name,
      category: entry.supply.category,
      quantityTotal: entry.supply.quantityTotal,
      isConsumable: entry.supply.isConsumable,
      bookingCount: entry.bookingIds.size,
      unitsUsed: entry.unitsUsed,
      peakConcurrent: peak,
      peakUtilization:
        entry.supply.quantityTotal > 0
          ? Math.round((peak / entry.supply.quantityTotal) * 100)
          : 0,
    };
  });

  result.sort(
    (a, b) => b.unitsUsed - a.unitsUsed || a.name.localeCompare(b.name)
  );

  return {
    rows: result,
    totals: {
      distinctSupplies: result.length,
      unitsUsed: result.reduce((sum, row) => sum + row.unitsUsed, 0),
      bookingsWithSupplies: bookingsWithSupplies.size,
    },
  };
}
