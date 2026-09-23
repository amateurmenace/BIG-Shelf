import { beforeEach, describe, expect, it, vi } from "vitest";

// why: mock the database so the service's Prisma reads don't hit a real DB.
// bookingNeedsAgreementSignature integrates getActiveTemplate + hasSignedForBooking,
// so we stub those two reads and assert the observable boolean for each state.
vi.mock("~/database/db.server", () => ({
  db: {
    loanAgreementTemplate: { findUnique: vi.fn() },
    loanAgreementSignature: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    asset: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

// why: supply lines come from the supplies module's own query; stub its answer.
vi.mock("~/modules/big-supply/service.server", () => ({
  getBookingSupplies: vi.fn(),
}));

import { db } from "~/database/db.server";
import { getBookingSupplies } from "~/modules/big-supply/service.server";

import {
  bookingNeedsAgreementSignature,
  formatLoanItemsMarkdown,
  getLoanItems,
  getSignatureSummary,
  recordSignature,
  type LoanItems,
} from "./service.server";

const ORG = "org_1";
const BOOKING = "booking_1";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
/** The workspace has (or hasn't) a configured agreement template. */
const withTemplate = (v: unknown) =>
  mockFn(db.loanAgreementTemplate.findUnique).mockResolvedValue(v);
/** How many signatures already exist for the booking. */
const withSignatureCount = (n: number) =>
  mockFn(db.loanAgreementSignature.count).mockResolvedValue(n);

const needsSignature = () =>
  bookingNeedsAgreementSignature({ bookingId: BOOKING, organizationId: ORG });

describe("bookingNeedsAgreementSignature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default arrangement: template configured, booking not yet signed.
    withTemplate({ id: "tmpl_1", organizationId: ORG });
    withSignatureCount(0);
  });

  it("requires a signature for any unsigned reservation", async () => {
    await expect(needsSignature()).resolves.toBe(true);
  });

  it("is a no-op when the workspace has no agreement template", async () => {
    withTemplate(null);
    await expect(needsSignature()).resolves.toBe(false);
    // Short-circuits before checking for a signature.
    expect(db.loanAgreementSignature.count).not.toHaveBeenCalled();
  });

  it("no longer requires a signature once the reservation is signed", async () => {
    withSignatureCount(1);
    await expect(needsSignature()).resolves.toBe(false);
  });
});

/** A resolved label code, as the shared resolver returns it. */
const code = (value: string) => ({
  value,
  type: "SAM_ID" as const,
  isFallback: false,
  workspacePreference: "SAM_ID" as const,
});

describe("formatLoanItemsMarkdown — the list inside the agreement text", () => {
  const camera = { id: "a1", title: "Canon C70", code: code("SAM-0042") };
  const batteries = {
    id: "s1",
    name: "AA batteries",
    quantity: 4,
    isConsumable: true,
  };

  it("reads exactly as before for an equipment-only loan, plus each label code", () => {
    expect(formatLoanItemsMarkdown({ assets: [camera], supplies: [] })).toBe(
      "- Canon C70 (SAM-0042)"
    );
  });

  it("lists supplies with quantities under their own heading", () => {
    expect(
      formatLoanItemsMarkdown({ assets: [camera], supplies: [batteries] })
    ).toBe(
      "**Equipment**\n\n- Canon C70 (SAM-0042)\n\n**Supplies**\n\n- 4 × AA batteries"
    );
  });

  it("still lists supplies when there is no equipment", () => {
    expect(formatLoanItemsMarkdown({ assets: [], supplies: [batteries] })).toBe(
      "**Supplies**\n\n- 4 × AA batteries"
    );
  });

  it("keeps the old placeholder when nothing has been added yet", () => {
    expect(formatLoanItemsMarkdown({ assets: [], supplies: [] })).toBe(
      "- (equipment will be listed at checkout)"
    );
  });
});

describe("getLoanItems — everything the borrower takes away", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the equipment with each label code, and the supply lines, scoped to the org", async () => {
    mockFn(db.asset.findMany).mockResolvedValue([
      {
        id: "a1",
        title: "Canon C70",
        sequentialId: "SAM-0042",
        preferredBarcodeId: null,
        qrCodes: [{ id: "qr1" }],
        barcodes: [],
      },
    ]);
    mockFn(getBookingSupplies).mockResolvedValue([
      {
        id: "line1",
        supplyId: "s1",
        name: "AA batteries",
        category: "Power",
        quantity: 4,
        isConsumable: true,
        storageLocation: null,
      },
    ]);

    const items: LoanItems = await getLoanItems({
      bookingId: BOOKING,
      organizationId: ORG,
      organization: { qrIdDisplayPreference: "SAM_ID", barcodesEnabled: false },
    });

    expect(mockFn(db.asset.findMany).mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      bookings: { some: { id: BOOKING } },
    });
    expect(getBookingSupplies).toHaveBeenCalledWith({
      bookingId: BOOKING,
      organizationId: ORG,
    });
    expect(items.assets).toEqual([
      expect.objectContaining({
        title: "Canon C70",
        code: expect.objectContaining({ value: "SAM-0042" }),
      }),
    ]);
    expect(items.supplies).toEqual([
      { id: "line1", name: "AA batteries", quantity: 4, isConsumable: true },
    ]);
  });
});

describe("signing method — digital or paper", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    organizationId: ORG,
    bookingId: BOOKING,
    signedByUserId: "u-staff",
    signerName: "Ava Whitfield",
    signerEmail: "ava@example.com",
    template: { title: "Equipment Loan Agreement", version: 1 },
    contentSnapshot: "terms",
  };

  it("records an e-signature as DIGITAL by default", async () => {
    await recordSignature(base);
    expect(
      mockFn(db.loanAgreementSignature.create).mock.calls[0][0].data
    ).toMatchObject({ method: "DIGITAL" });
  });

  it("records a paper signature as PAPER", async () => {
    await recordSignature({ ...base, method: "PAPER" });
    expect(
      mockFn(db.loanAgreementSignature.create).mock.calls[0][0].data
    ).toMatchObject({ method: "PAPER", signedByUserId: "u-staff" });
  });

  it("names the staff member who recorded a paper signature", async () => {
    mockFn(db.loanAgreementSignature.findFirst).mockResolvedValue({
      method: "PAPER",
      signerName: "Ava Whitfield",
      signedAt: new Date("2026-09-23T10:00:00Z"),
      signedByUserId: "u-staff",
    });
    mockFn(db.user.findUnique).mockResolvedValue({
      firstName: "Dee",
      lastName: "Admin",
      email: "dee@example.org",
    });

    const summary = await getSignatureSummary({
      bookingId: BOOKING,
      organizationId: ORG,
    });

    expect(summary).toMatchObject({
      method: "PAPER",
      signerName: "Ava Whitfield",
      recordedBy: "Dee Admin",
    });
  });

  it("has no recorder for a digital signature", async () => {
    mockFn(db.loanAgreementSignature.findFirst).mockResolvedValue({
      method: "DIGITAL",
      signerName: "Ava Whitfield",
      signedAt: new Date(),
      signedByUserId: "u-ava",
    });

    const summary = await getSignatureSummary({
      bookingId: BOOKING,
      organizationId: ORG,
    });

    expect(summary?.recordedBy).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
