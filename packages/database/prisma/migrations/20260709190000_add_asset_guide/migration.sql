-- BIG: AssetGuide — admin-managed learning content per asset (manual links,
-- video explainers) rendered on the member equipment info page. Additive:
-- plain organizationId/assetId columns, no FK relations on upstream tables.

-- CreateEnum
CREATE TYPE "AssetGuideKind" AS ENUM ('MANUAL', 'VIDEO', 'LINK');

-- CreateTable
CREATE TABLE "AssetGuide" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" "AssetGuideKind" NOT NULL DEFAULT 'LINK',
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetGuide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetGuide_assetId_idx" ON "AssetGuide"("assetId");
CREATE INDEX "AssetGuide_organizationId_assetId_idx" ON "AssetGuide"("organizationId", "assetId");

-- Every new additive table must enable Row-Level Security (no policies =
-- deny-all for the anon Data API; the app reads via Prisma as table owner).
ALTER TABLE "AssetGuide" ENABLE ROW LEVEL SECURITY;
