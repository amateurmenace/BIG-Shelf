-- BIG: record whether a loan agreement was signed digitally or on paper.
--
-- Staff running an in-person or staff-arranged reservation can print the
-- agreement, have the borrower sign the paper copy, and record that in BIG
-- Shelf instead of the borrower e-signing. Either kind satisfies the checkout
-- gate; this column keeps the audit trail honest about which one happened.
--
-- Additive and safe: every existing signature was digital, which is exactly
-- what the default gives them. LoanAgreementSignature already has RLS enabled
-- (migration 20260707000003), and adding a column does not change that.

-- CreateEnum
CREATE TYPE "LoanAgreementSignatureMethod" AS ENUM ('DIGITAL', 'PAPER');

-- AlterTable
ALTER TABLE "LoanAgreementSignature" ADD COLUMN     "method" "LoanAgreementSignatureMethod" NOT NULL DEFAULT 'DIGITAL';
