-- BIG: close the Supabase "rls_disabled_in_public" security alert.
--
-- shelf.nu's 60 other public tables already have Row-Level Security enabled;
-- these additive tables (BIG's Rooms + the new loan-agreement and asset-
-- condition tables, plus Prisma's migrations table) were created without it, so
-- the anon/PostgREST Data API could read/write them.
--
-- The app never uses the anon Data API for these tables — it reads them via
-- Prisma as the table OWNER, which bypasses RLS. So enabling RLS with NO
-- policies denies all anon/authenticated PostgREST access while leaving the app
-- fully working (identical to how the other 60 tables are configured).

ALTER TABLE "Room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_BookingToRoom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanAgreementTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanAgreementSignature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetConditionLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetConditionImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
