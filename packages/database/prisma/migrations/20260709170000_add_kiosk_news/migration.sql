-- BIG: kiosk news/announcement banner. Additive — one nullable column on the
-- existing KioskConfig table (already RLS-enabled). Admin-authored lines shown
-- in the kiosk's top banner (newline-separated; the kiosk rotates through them).

-- AlterTable
ALTER TABLE "KioskConfig" ADD COLUMN "newsMessages" TEXT;
