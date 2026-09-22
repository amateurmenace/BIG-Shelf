-- BIG: remember which Neon member a non-registered TeamMember was created for.
--
-- Staff reserve for members who have never logged in by picking them from the
-- Neon directory, which creates a non-registered TeamMember to hold the booking.
-- TeamMember has no email column, so until now such a record could only be
-- matched back to its person by NAME: they showed up twice in the "Reserved for"
-- picker, and two members who share a name would have been merged into one.
--
-- Keyed by email rather than by NeonAllowlistMember id, because the Neon sync
-- deletes and re-inserts every allowlist row — those ids change on every run.
--
-- Purely additive: a new, empty table. Nothing existing is altered, so the
-- currently deployed release is unaffected until the new code ships.
-- CreateTable
CREATE TABLE "MemberDirectoryLink" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberDirectoryLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberDirectoryLink_teamMemberId_key" ON "MemberDirectoryLink"("teamMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDirectoryLink_organizationId_email_key" ON "MemberDirectoryLink"("organizationId", "email");

-- AddForeignKey
ALTER TABLE "MemberDirectoryLink" ADD CONSTRAINT "MemberDirectoryLink_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDirectoryLink" ADD CONSTRAINT "MemberDirectoryLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- BIG rule: every additive table must enable RLS in its migration. shelf enables
-- RLS on public tables OUTSIDE migrations, so a Prisma-created table ships without
-- it and trips Supabase's `rls_disabled_in_public` alert (the anon Data API could
-- read/write it). The app reads this table via Prisma as the table OWNER, which
-- bypasses RLS, so enabling it with NO policies is deny-all for anon and leaves
-- the app unaffected.
ALTER TABLE "MemberDirectoryLink" ENABLE ROW LEVEL SECURITY;
