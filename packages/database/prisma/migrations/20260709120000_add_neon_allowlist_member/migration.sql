-- BIG: Neon member allowlist (synced active-member snapshot).
--
-- One row per ACTIVE Neon member, refreshed by the admin "Sync members from
-- Neon" action. The app enforces membership against THIS table (email on the
-- list ⇒ active member) instead of making a live Neon API call at gate time.
-- The sync replaces the set each run (upsert current, delete stale) and creates
-- NO login accounts, Supabase users, or passwords.

-- CreateTable
CREATE TABLE "NeonAllowlistMember" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "neonAccountId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NeonAllowlistMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NeonAllowlistMember_email_key" ON "NeonAllowlistMember"("email");

-- CreateIndex
CREATE INDEX "NeonAllowlistMember_neonAccountId_idx" ON "NeonAllowlistMember"("neonAccountId");

-- BIG: every additive table must enable Row-Level Security. shelf enables RLS on
-- public tables OUTSIDE migrations, so a Prisma-created table ships without it and
-- trips Supabase's rls_disabled_in_public alert (the anon Data API could read the
-- member list). The app reads this table via Prisma as the table OWNER (bypassing
-- RLS), so enabling RLS with NO policies is deny-all for anon and leaves the app
-- unaffected. Matches the pattern in 20260707000003_enable_rls_on_additive_tables.
ALTER TABLE "NeonAllowlistMember" ENABLE ROW LEVEL SECURITY;
