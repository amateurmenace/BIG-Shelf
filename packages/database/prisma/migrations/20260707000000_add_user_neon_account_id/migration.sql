-- BIG: link a User to their Neon CRM constituent record (member identity /
-- source of truth for membership). Additive + nullable — no data change.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "neonAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_neonAccountId_key" ON "User"("neonAccountId");
