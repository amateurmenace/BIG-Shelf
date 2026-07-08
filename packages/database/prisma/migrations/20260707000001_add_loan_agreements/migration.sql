-- BIG: digital loan agreements. Additive — two new tables, no foreign keys to
-- existing tables and no changes to existing data.

-- CreateTable
CREATE TABLE "LoanAgreementTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanAgreementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanAgreementSignature" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "signedByUserId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "agreementTitle" TEXT NOT NULL,
    "agreementVersion" INTEGER NOT NULL,
    "contentSnapshot" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanAgreementSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanAgreementTemplate_organizationId_key" ON "LoanAgreementTemplate"("organizationId");

-- CreateIndex
CREATE INDEX "LoanAgreementSignature_bookingId_idx" ON "LoanAgreementSignature"("bookingId");

-- CreateIndex
CREATE INDEX "LoanAgreementSignature_organizationId_idx" ON "LoanAgreementSignature"("organizationId");

-- CreateIndex
CREATE INDEX "LoanAgreementSignature_signedByUserId_idx" ON "LoanAgreementSignature"("signedByUserId");
