/**
 * BIG Automated Booking Reminders — server service
 *
 * A day-ahead reminder layer on top of shelf's existing (1-hour) booking
 * reminders: it emails the reservation's custodian when a booking is starting
 * soon (PICKUP), due back soon (RETURN), or overdue (OVERDUE, re-nudged ~daily).
 *
 * Delivery is driven by a self-rescheduling pg-boss sweep (see
 * `worker.server.ts`) — NOT cron — so it works under the fork's
 * `noScheduling: true`. Each sent reminder is recorded in `BookingReminderLog`
 * so a reminder is never emailed twice (PICKUP/RETURN at-most-once; OVERDUE
 * re-arms only after ~a day).
 *
 * @see {@link file://./worker.server.ts}
 * @see {@link file://./../../../packages/database/prisma/schema.prisma} — BookingReminderLog
 */
import type { Prisma } from "@prisma/client";
import { BookingReminderType, BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sendEmail } from "~/emails/mail.server";
import { SERVER_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";

const label = "Reminder" as const;

/** Day-ahead lead: remind when a booking starts/ends within this window. */
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
/** Overdue re-arm: re-nudge an overdue booking once its last nudge is older. */
const OVERDUE_REARM_MS = 20 * 60 * 60 * 1000;

/** Fields needed to decide on + compose a reminder. */
const REMINDER_SELECT = {
  id: true,
  name: true,
  from: true,
  to: true,
  organizationId: true,
  custodianUser: { select: { email: true, firstName: true } },
} satisfies Prisma.BookingSelect;

type ReminderBooking = Prisma.BookingGetPayload<{
  select: typeof REMINDER_SELECT;
}>;

/** Builds the subject + plain-text body for a reminder email. */
function reminderEmail(
  type: BookingReminderType,
  booking: ReminderBooking
): { subject: string; text: string } {
  const url = `${SERVER_URL}/bookings/${booking.id}`;
  const greeting = `Hi ${booking.custodianUser?.firstName ?? "there"},`;
  const footer = ["", `Details: ${url}`, "", "— The BIG Shelf team"];

  switch (type) {
    case BookingReminderType.PICKUP:
      return {
        subject: `⏰ Reminder: your reservation "${booking.name}" starts soon`,
        text: [
          greeting,
          "",
          `This is a reminder that your reservation "${booking.name}" is scheduled to start within the next day. Please pick up your equipment on time.`,
          ...footer,
        ].join("\n"),
      };
    case BookingReminderType.RETURN:
      return {
        subject: `⏰ Reminder: "${booking.name}" is due back soon`,
        text: [
          greeting,
          "",
          `This is a reminder that the equipment for "${booking.name}" is due back within the next day. Please return it on time so the next member can use it.`,
          ...footer,
        ].join("\n"),
      };
    case BookingReminderType.OVERDUE:
      return {
        subject: `⚠️ Overdue: please return "${booking.name}"`,
        text: [
          greeting,
          "",
          `The equipment for "${booking.name}" is now overdue. Please return it as soon as possible so it can be made available to others.`,
          ...footer,
        ].join("\n"),
      };
  }
}

/**
 * Sends one reminder type to the bookings that need it and logs each send.
 *
 * @param candidates - Bookings matching the type's status/time window
 * @param type - Which reminder to send
 * @param reArmAfter - For OVERDUE, only (re)send when the newest log is older
 *   than this; `null` means at-most-once (PICKUP/RETURN)
 * @returns The number of reminders emailed
 */
async function sendRemindersForType(
  candidates: ReminderBooking[],
  type: BookingReminderType,
  reArmAfter: Date | null
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  const bookingIds = candidates.map((booking) => booking.id);
  const recentLogs = await db.bookingReminderLog.findMany({
    where: {
      bookingId: { in: bookingIds },
      type,
      ...(reArmAfter ? { sentAt: { gte: reArmAfter } } : {}),
    },
    select: { bookingId: true },
  });
  const alreadyReminded = new Set(recentLogs.map((log) => log.bookingId));

  const toRemind = candidates.filter(
    (booking) =>
      !alreadyReminded.has(booking.id) && booking.custodianUser?.email
  );
  if (toRemind.length === 0) {
    return 0;
  }

  for (const booking of toRemind) {
    const { subject, text } = reminderEmail(type, booking);
    // sendEmail is fire-and-forget (queues on failure) — safe in a loop.
    sendEmail({ to: booking.custodianUser!.email, subject, text });
  }

  await db.bookingReminderLog.createMany({
    data: toRemind.map((booking) => ({
      organizationId: booking.organizationId,
      bookingId: booking.id,
      type,
    })),
  });

  return toRemind.length;
}

/**
 * One reminder sweep across ALL organizations: finds bookings due for a PICKUP,
 * RETURN, or OVERDUE reminder, emails their custodians, and records each send.
 * Idempotent — re-running within the dedup windows sends nothing new.
 *
 * @returns Counts of reminders sent, per type
 * @throws {ShelfError} If the sweep query fails
 */
export async function sweepReminders(): Promise<{
  pickup: number;
  return: number;
  overdue: number;
}> {
  const now = new Date();
  const within = new Date(now.getTime() + REMINDER_LEAD_MS);
  const overdueReArm = new Date(now.getTime() - OVERDUE_REARM_MS);

  try {
    const [pickupCandidates, returnCandidates, overdueCandidates] =
      await Promise.all([
        db.booking.findMany({
          where: {
            status: BookingStatus.RESERVED,
            from: { gte: now, lte: within },
          },
          select: REMINDER_SELECT,
        }),
        db.booking.findMany({
          where: {
            status: BookingStatus.ONGOING,
            to: { gte: now, lte: within },
          },
          select: REMINDER_SELECT,
        }),
        db.booking.findMany({
          where: { status: BookingStatus.OVERDUE },
          select: REMINDER_SELECT,
        }),
      ]);

    const [pickup, ret, overdue] = await Promise.all([
      sendRemindersForType(pickupCandidates, BookingReminderType.PICKUP, null),
      sendRemindersForType(returnCandidates, BookingReminderType.RETURN, null),
      sendRemindersForType(
        overdueCandidates,
        BookingReminderType.OVERDUE,
        overdueReArm
      ),
    ]);

    return { pickup, return: ret, overdue };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Reminder sweep failed",
      label,
    });
  }
}
