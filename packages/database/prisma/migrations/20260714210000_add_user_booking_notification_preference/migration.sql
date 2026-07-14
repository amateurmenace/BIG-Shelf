-- BIG: per-user, per-workspace booking-email preferences.
--
-- The org-level notification knobs (BookingSettings.notifyAdminsOnNewBooking) are
-- all-or-nothing — they silence EVERY admin at once. There was no way to stop
-- emailing one person on every reservation without stopping emails to the whole
-- team. This table adds the per-person layer.
--
-- A MISSING row means "receive everything", so this table only ever holds people
-- who have actually changed a setting. That keeps the default behaviour exactly
-- as it is today for everyone who never touches it.

-- CreateTable
CREATE TABLE "UserBookingNotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notifyOnReservation" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnOverdue" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBookingNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserBookingNotificationPreference_userId_organizationId_key"
    ON "UserBookingNotificationPreference"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "UserBookingNotificationPreference_organizationId_idx"
    ON "UserBookingNotificationPreference"("organizationId");

-- AddForeignKey
ALTER TABLE "UserBookingNotificationPreference"
    ADD CONSTRAINT "UserBookingNotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBookingNotificationPreference"
    ADD CONSTRAINT "UserBookingNotificationPreference_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BIG rule: every additive table must enable RLS in its migration. shelf enables
-- RLS on public tables OUTSIDE migrations, so a Prisma-created table ships without
-- it and trips Supabase's `rls_disabled_in_public` alert (the anon Data API could
-- read/write it). The app reads this table via Prisma as the table OWNER, which
-- bypasses RLS, so enabling it with NO policies is deny-all for anon and leaves
-- the app unaffected.
ALTER TABLE "UserBookingNotificationPreference" ENABLE ROW LEVEL SECURITY;
