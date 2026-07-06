-- BIG customization migration: adds the reservable "Room" entity and the
-- "MEMBER" organization role. Generated offline via `prisma migrate diff`
-- (datamodel-to-datamodel); reviewed by hand. Apply with `pnpm db:deploy-migration`.
--
-- NOTE on the enum change below: `ALTER TYPE ... ADD VALUE` is safe here because
-- no statement in this migration USES the new 'MEMBER' value. On Postgres 12+
-- (Supabase is 15+) this runs fine inside Prisma's migration transaction. If you
-- ever hit "ALTER TYPE ... cannot run inside a transaction block", split this one
-- ADD VALUE into its own earlier migration.

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('AVAILABLE', 'CHECKED_OUT');

-- AlterEnum
ALTER TYPE "OrganizationRoles" ADD VALUE 'MEMBER';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "roomId" TEXT;

-- AlterTable
ALTER TABLE "SsoDetails" ADD COLUMN     "memberGroupId" TEXT;

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "status" "RoomStatus" NOT NULL DEFAULT 'AVAILABLE',
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_BookingToRoom" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BookingToRoom_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Room_createdById_idx" ON "Room"("createdById");

-- CreateIndex
CREATE INDEX "Room_organizationId_idx" ON "Room"("organizationId");

-- CreateIndex
CREATE INDEX "Room_organizationId_name_idx" ON "Room"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Room_organizationId_status_idx" ON "Room"("organizationId", "status");

-- CreateIndex
CREATE INDEX "_BookingToRoom_B_index" ON "_BookingToRoom"("B");

-- CreateIndex
CREATE INDEX "Asset_roomId_organizationId_idx" ON "Asset"("roomId", "organizationId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BookingToRoom" ADD CONSTRAINT "_BookingToRoom_A_fkey" FOREIGN KEY ("A") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BookingToRoom" ADD CONSTRAINT "_BookingToRoom_B_fkey" FOREIGN KEY ("B") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
