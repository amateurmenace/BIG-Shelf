-- BIG: asset condition & maintenance log with photos. Additive — new enums +
-- two new tables (the image table FKs the log table). No changes to existing tables.

-- CreateEnum
CREATE TYPE "AssetConditionType" AS ENUM ('CONDITION', 'DAMAGE', 'MAINTENANCE', 'INSPECTION');

-- CreateEnum
CREATE TYPE "AssetConditionGrade" AS ENUM ('GOOD', 'FAIR', 'POOR', 'OUT_OF_SERVICE');

-- CreateTable
CREATE TABLE "AssetConditionLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "AssetConditionType" NOT NULL DEFAULT 'CONDITION',
    "grade" "AssetConditionGrade",
    "note" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetConditionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetConditionImage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conditionLogId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetConditionImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetConditionLog_assetId_idx" ON "AssetConditionLog"("assetId");

-- CreateIndex
CREATE INDEX "AssetConditionLog_organizationId_idx" ON "AssetConditionLog"("organizationId");

-- CreateIndex
CREATE INDEX "AssetConditionImage_conditionLogId_idx" ON "AssetConditionImage"("conditionLogId");

-- CreateIndex
CREATE INDEX "AssetConditionImage_organizationId_idx" ON "AssetConditionImage"("organizationId");

-- AddForeignKey
ALTER TABLE "AssetConditionImage" ADD CONSTRAINT "AssetConditionImage_conditionLogId_fkey" FOREIGN KEY ("conditionLogId") REFERENCES "AssetConditionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
