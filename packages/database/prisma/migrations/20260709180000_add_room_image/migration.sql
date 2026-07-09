-- Add an optional room photo to the Room table (BIG-only, additive).
-- Stored as a PUBLIC-bucket URL + storage path, mirroring KioskPromo — no
-- signed-URL expiration to manage. Both nullable, so existing rooms are
-- unaffected and prod code that predates these columns keeps working.
ALTER TABLE "Room" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "Room" ADD COLUMN "imagePath" TEXT;

-- Room already has Row-Level Security enabled (see the
-- *_enable_rls_on_additive_tables migration); adding columns does not change it,
-- so no RLS statement is needed here.
