-- BIG: kiosk wallboard content. Additive — two new tables, no changes to
-- existing tables. Plain-FK (no FKs to core tables); integrity is enforced in
-- the app layer via org-scoping. RLS is enabled with no policies (deny-all for
-- the anon Data API; the app reads via Prisma as the table owner), matching
-- the other BIG additive tables.

-- CreateTable
CREATE TABLE "KioskPromo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3),
    "linkUrl" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "imagePath" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KioskPromo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KioskConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipHeadline" TEXT,
    "membershipBlurb" TEXT,
    "membershipSignupUrl" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KioskConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KioskPromo_organizationId_idx" ON "KioskPromo"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "KioskConfig_organizationId_key" ON "KioskConfig"("organizationId");

-- Enable Row-Level Security on the new additive tables (deny-all for anon;
-- the app reads via Prisma as the table owner and is unaffected). See the
-- *_enable_rls_on_additive_tables migration for the pattern.
ALTER TABLE "KioskPromo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KioskConfig" ENABLE ROW LEVEL SECURITY;
