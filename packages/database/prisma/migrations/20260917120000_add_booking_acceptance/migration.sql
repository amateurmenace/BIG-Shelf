-- BIG: "reserved on behalf of" acceptance.
--
-- Staff routinely book equipment for a member who phoned, emailed or asked at
-- the desk. The booking belongs to that member (they are its custodian), but
-- until now nothing told them it existed or gave them a way to say no. This
-- table records the outstanding "do you accept?" question.
--
-- Deliberately NOT part of the booking lifecycle: the reservation holds the
-- equipment from the moment it is reserved, so a member who takes two days to
-- reply cannot lose the gear to someone else in the meantime. A DECLINE is a
-- signal to staff, who then cancel the booking themselves.

-- CreateEnum
CREATE TYPE "BookingAcceptanceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "BookingAcceptance" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedForUserId" TEXT,
    "status" "BookingAcceptanceStatus" NOT NULL DEFAULT 'PENDING',
    "responseNote" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingAcceptance_bookingId_key" ON "BookingAcceptance"("bookingId");

-- CreateIndex
CREATE INDEX "BookingAcceptance_organizationId_status_idx"
    ON "BookingAcceptance"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BookingAcceptance_requestedForUserId_status_idx"
    ON "BookingAcceptance"("requestedForUserId", "status");

-- AddForeignKey
ALTER TABLE "BookingAcceptance"
    ADD CONSTRAINT "BookingAcceptance_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAcceptance"
    ADD CONSTRAINT "BookingAcceptance_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAcceptance"
    ADD CONSTRAINT "BookingAcceptance_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAcceptance"
    ADD CONSTRAINT "BookingAcceptance_requestedForUserId_fkey"
    FOREIGN KEY ("requestedForUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BIG rule: every additive table must enable RLS in its migration. shelf enables
-- RLS on public tables OUTSIDE migrations, so a Prisma-created table ships without
-- it and trips Supabase's `rls_disabled_in_public` alert (the anon Data API could
-- read/write it). The app reads this table via Prisma as the table OWNER, which
-- bypasses RLS, so enabling it with NO policies is deny-all for anon and leaves
-- the app unaffected.
ALTER TABLE "BookingAcceptance" ENABLE ROW LEVEL SECURITY;
