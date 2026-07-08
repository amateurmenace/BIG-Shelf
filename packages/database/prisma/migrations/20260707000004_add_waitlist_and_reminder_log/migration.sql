-- BIG: equipment waitlists + booking reminder log. Additive — new enums + two
-- new tables, no changes to existing tables. Plain-FK (no FKs to core tables);
-- integrity is enforced in the app layer via org-scoping. RLS is enabled with
-- no policies (deny-all for the anon Data API; the app reads via Prisma as the
-- table owner), matching the other BIG additive tables.

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'NOTIFIED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingReminderType" AS ENUM ('PICKUP', 'RETURN', 'OVERDUE');

-- CreateTable
CREATE TABLE "Waitlist" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "from" TIMESTAMPTZ(3) NOT NULL,
    "to" TIMESTAMPTZ(3) NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingReminderLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" "BookingReminderType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Waitlist_assetId_idx" ON "Waitlist"("assetId");

-- CreateIndex
CREATE INDEX "Waitlist_assetId_status_idx" ON "Waitlist"("assetId", "status");

-- CreateIndex
CREATE INDEX "Waitlist_organizationId_idx" ON "Waitlist"("organizationId");

-- CreateIndex
CREATE INDEX "Waitlist_requestedByUserId_idx" ON "Waitlist"("requestedByUserId");

-- CreateIndex
CREATE INDEX "BookingReminderLog_bookingId_idx" ON "BookingReminderLog"("bookingId");

-- CreateIndex
CREATE INDEX "BookingReminderLog_bookingId_type_idx" ON "BookingReminderLog"("bookingId", "type");

-- CreateIndex
CREATE INDEX "BookingReminderLog_organizationId_idx" ON "BookingReminderLog"("organizationId");

-- BIG: enable RLS (no policies = deny-all for the anon Data API; app uses Prisma as owner)
ALTER TABLE "Waitlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingReminderLog" ENABLE ROW LEVEL SECURITY;
