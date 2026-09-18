/**
 * Booking acceptance service
 *
 * Handles the "reserved on behalf of" loop: staff reserve equipment for a
 * member, the member is emailed, and the member confirms or declines from the
 * booking page.
 *
 * Design notes:
 * - The acceptance row is **advisory**. The booking itself is fully reserved
 *   from the moment staff create it, so the equipment is held whether or not
 *   the member has replied. A DECLINE is a prompt for staff to cancel, not an
 *   automatic cancellation — releasing gear without a human in the loop is how
 *   you lose a shoot to a mis-click.
 * - Everything here is org-scoped at the app layer. The table carries a plain
 *   `organizationId` column (see the schema comment) rather than relying on
 *   Prisma relations into upstream models.
 *
 * @see {@link file://./shared.ts} — client-safe constants/schemas
 * @see {@link file://./../../routes/_layout+/bookings.$bookingId.overview.tsx}
 */
import type { Organization, User } from "@prisma/client";
import { BookingAcceptanceStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sendBookingAcceptanceRequestEmail } from "~/emails/big/booking-acceptance-request";
import type { ClientHint } from "~/utils/client-hints";
import { getDateTimeFormatFromHints } from "~/utils/client-hints";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";

const label = "Booking" as const;

/** The acceptance row shape the booking page needs. */
export type BookingAcceptanceSummary = {
  status: BookingAcceptanceStatus;
  responseNote: string | null;
  respondedAt: Date | null;
  requestedByName: string;
  requestedForName: string | null;
  /** Null when the booking is for a non-registered member. */
  requestedForUserId: string | null;
};

/**
 * Reads the acceptance row for a booking, if one exists.
 *
 * Most bookings have none (staff booking for themselves, members booking for
 * themselves), so a null return is the normal case, not an error.
 *
 * @param bookingId - The booking to look up.
 * @param organizationId - The caller's organization, for scoping.
 * @returns The acceptance summary, or null when the booking was not made on
 *   anyone's behalf.
 */
export async function getBookingAcceptance({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: Organization["id"];
}): Promise<BookingAcceptanceSummary | null> {
  try {
    const row = await db.bookingAcceptance.findFirst({
      where: { bookingId, organizationId },
    });

    if (!row) return null;

    const [requestedBy, requestedFor] = await Promise.all([
      db.user.findUnique({
        where: { id: row.requestedByUserId },
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          email: true,
        },
      }),
      row.requestedForUserId
        ? db.user.findUnique({
            where: { id: row.requestedForUserId },
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              email: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return {
      status: row.status,
      responseNote: row.responseNote,
      respondedAt: row.respondedAt,
      requestedByName: requestedBy
        ? resolveUserDisplayName(requestedBy)
        : "A member of staff",
      requestedForName: requestedFor
        ? resolveUserDisplayName(requestedFor)
        : null,
      requestedForUserId: row.requestedForUserId,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not load the acceptance status for this booking.",
      additionalData: { bookingId, organizationId },
      label,
    });
  }
}

/**
 * Records that a booking was made on someone else's behalf and emails them.
 *
 * Call this AFTER the booking is reserved — it is deliberately best-effort and
 * never throws, so a mail or database hiccup cannot undo a reservation that has
 * already taken a hold on equipment.
 *
 * No-ops when:
 * - the booking's custodian is the person who created it (booking for yourself)
 * - a row already exists (re-reserving after a revert-to-draft should not spam)
 *
 * @param args.bookingId - The booking that was just reserved.
 * @param args.organizationId - Owning organization.
 * @param args.requestedByUserId - The staff member who made the reservation.
 * @param args.hints - Client hints, for formatting the period in the email.
 */
export async function requestBookingAcceptance({
  bookingId,
  organizationId,
  requestedByUserId,
  hints,
}: {
  bookingId: string;
  organizationId: Organization["id"];
  requestedByUserId: User["id"];
  hints: ClientHint;
}): Promise<void> {
  try {
    const booking = await db.booking.findFirst({
      where: { id: bookingId, organizationId },
      select: {
        id: true,
        name: true,
        from: true,
        to: true,
        custodianUserId: true,
        creatorId: true,
        organization: { select: { name: true } },
        rooms: { select: { name: true } },
        _count: { select: { assets: true } },
        custodianUser: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            displayName: true,
          },
        },
      },
    });

    // Booking for yourself, or a custodian with no login to notify — nothing
    // to ask, so no row and no email.
    if (
      !booking?.custodianUser ||
      booking.custodianUser.id === requestedByUserId
    ) {
      return;
    }

    const existing = await db.bookingAcceptance.findUnique({
      where: { bookingId },
      select: { id: true },
    });
    if (existing) return;

    await db.bookingAcceptance.create({
      data: {
        bookingId,
        organizationId,
        requestedByUserId,
        requestedForUserId: booking.custodianUser.id,
        status: BookingAcceptanceStatus.PENDING,
      },
    });

    const requestedBy = await db.user.findUnique({
      where: { id: requestedByUserId },
      select: {
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
      },
    });

    const { format } = getDateTimeFormatFromHints(hints, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    await sendBookingAcceptanceRequestEmail({
      firstName:
        booking.custodianUser.firstName || booking.custodianUser.displayName,
      email: booking.custodianUser.email,
      bookingName: booking.name,
      bookingId: booking.id,
      period: `${format(booking.from)} - ${format(booking.to)}`,
      reservedBy: requestedBy
        ? resolveUserDisplayName(requestedBy)
        : "A member of staff",
      assetCount: booking._count.assets,
      roomNames: booking.rooms.map((room) => room.name),
      organizationName: booking.organization.name,
    });
  } catch (cause) {
    // why: best-effort by design. The reservation itself already succeeded;
    // failing here must not surface as a booking failure.
    Logger.error(
      new ShelfError({
        cause,
        message: "Failed to request booking acceptance",
        additionalData: { bookingId, organizationId, requestedByUserId },
        label,
      })
    );
  }
}

/**
 * Records the recipient's answer to an acceptance request.
 *
 * Only the person the booking was made for may respond — an admin cannot
 * accept on their behalf, because the whole point of the row is *their*
 * confirmation.
 *
 * @param args.bookingId - The booking being responded to.
 * @param args.organizationId - The caller's organization, for scoping.
 * @param args.userId - The responding user; must match `requestedForUserId`.
 * @param args.accepted - True to accept, false to decline.
 * @param args.responseNote - Optional note shown to staff on decline.
 * @throws {ShelfError} 403 when the caller is not the intended recipient, 404
 *   when there is no pending request.
 */
export async function respondToBookingAcceptance({
  bookingId,
  organizationId,
  userId,
  accepted,
  responseNote,
}: {
  bookingId: string;
  organizationId: Organization["id"];
  userId: User["id"];
  accepted: boolean;
  responseNote?: string;
}) {
  const row = await db.bookingAcceptance.findFirst({
    where: { bookingId, organizationId },
  });

  if (!row) {
    throw new ShelfError({
      cause: null,
      message: "There is no pending confirmation for this booking.",
      additionalData: { bookingId, organizationId },
      status: 404,
      shouldBeCaptured: false,
      label,
    });
  }

  if (row.requestedForUserId !== userId) {
    throw new ShelfError({
      cause: null,
      title: "Not allowed",
      message:
        "Only the person this booking was made for can confirm or decline it.",
      additionalData: { bookingId, organizationId, userId },
      status: 403,
      shouldBeCaptured: false,
      label,
    });
  }

  return db.bookingAcceptance.update({
    // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: `row` was just read via findFirst({ where: { bookingId, organizationId } }) above, so this id is already proven to belong to the caller's organization; this is the write on that same proven row
    where: { id: row.id },
    data: {
      status: accepted
        ? BookingAcceptanceStatus.ACCEPTED
        : BookingAcceptanceStatus.DECLINED,
      responseNote: accepted ? null : responseNote || null,
      respondedAt: new Date(),
    },
  });
}
