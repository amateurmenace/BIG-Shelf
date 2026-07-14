-- BIG: record the HEALTH of the Neon allowlist sync, not just its successes.
--
-- `NeonAllowlistMember.syncedAt` only advances when a sync SUCCEEDS. When a sync
-- fails, the allowlist keeps its stale rows and nothing anywhere records that the
-- refresh failed — which is how a revoked Neon API key silently froze the
-- allowlist while the reserve gate went on denying members who joined after it.
--
-- One row (id = 'singleton'). The admin UI renders it; the reserve gate reads it
-- to decide whether the allowlist is fresh enough to be trusted as a denial.

-- CreateTable
CREATE TABLE "NeonSyncStatus" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "activeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NeonSyncStatus_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton from the allowlist we already have, so an existing install
-- doesn't look "never synced" (and therefore untrusted) on the first deploy.
INSERT INTO "NeonSyncStatus" ("id", "lastSuccessAt", "activeCount", "updatedAt")
SELECT
    'singleton',
    MAX("syncedAt"),
    COUNT(*)::int,
    CURRENT_TIMESTAMP
FROM "NeonAllowlistMember"
ON CONFLICT ("id") DO NOTHING;

-- BIG rule: every additive table must enable RLS in its migration. shelf enables
-- RLS on public tables OUTSIDE migrations, so a Prisma-created table ships without
-- it and trips Supabase's `rls_disabled_in_public` alert (the anon Data API could
-- read/write it). The app reads this table via Prisma as the table OWNER, which
-- bypasses RLS, so enabling it with NO policies is deny-all for anon and leaves
-- the app unaffected.
ALTER TABLE "NeonSyncStatus" ENABLE ROW LEVEL SECURITY;
