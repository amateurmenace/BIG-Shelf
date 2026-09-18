-- BIG: supplies (consumables & accessories).
--
-- Cables, batteries, adapters, gels and media are not assets. There are
-- eighteen identical 25ft XLR cables in a bin; labelling each one, listing each
-- one, and booking each one individually is work nobody wants to do and data
-- nobody wants to read. A Supply is therefore a TYPE with a quantity on hand,
-- and BookingSupply records "this booking takes N of them".
--
-- Availability is quantity arithmetic across overlapping bookings rather than
-- per-unit status, which is why none of this touches the Asset tables.

-- CreateEnum
CREATE TYPE "SupplyCategory" AS ENUM (
    'CABLE',
    'BATTERY',
    'MEDIA',
    'POWER',
    'AUDIO',
    'LIGHTING',
    'MOUNTING',
    'ADAPTER',
    'CONSUMABLE',
    'OTHER'
);

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "SupplyCategory" NOT NULL DEFAULT 'OTHER',
    "quantityTotal" INTEGER NOT NULL DEFAULT 0,
    "storageLocation" TEXT,
    "isConsumable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSupply" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSupply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supply_organizationId_name_key" ON "Supply"("organizationId", "name");
CREATE INDEX "Supply_organizationId_active_idx" ON "Supply"("organizationId", "active");
CREATE INDEX "Supply_organizationId_category_idx" ON "Supply"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSupply_bookingId_supplyId_key" ON "BookingSupply"("bookingId", "supplyId");
CREATE INDEX "BookingSupply_supplyId_idx" ON "BookingSupply"("supplyId");
CREATE INDEX "BookingSupply_organizationId_idx" ON "BookingSupply"("organizationId");

-- AddForeignKey
ALTER TABLE "Supply"
    ADD CONSTRAINT "Supply_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Supply"
    ADD CONSTRAINT "Supply_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingSupply"
    ADD CONSTRAINT "BookingSupply_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingSupply"
    ADD CONSTRAINT "BookingSupply_supplyId_fkey"
    FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingSupply"
    ADD CONSTRAINT "BookingSupply_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BIG rule: every additive table must enable RLS in its migration. shelf enables
-- RLS on public tables OUTSIDE migrations, so a Prisma-created table ships without
-- it and trips Supabase's `rls_disabled_in_public` alert (the anon Data API could
-- read/write it). The app reads these tables via Prisma as the table OWNER, which
-- bypasses RLS, so enabling it with NO policies is deny-all for anon and leaves
-- the app unaffected.
ALTER TABLE "Supply" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingSupply" ENABLE ROW LEVEL SECURITY;
