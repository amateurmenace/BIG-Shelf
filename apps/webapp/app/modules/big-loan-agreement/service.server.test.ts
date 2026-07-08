import { beforeEach, describe, expect, it, vi } from "vitest";

// why: mock the database so the service's Prisma reads don't hit a real DB.
// bookingNeedsAgreementSignature integrates getActiveTemplate + hasSignedForBooking,
// so we stub those two reads and assert the observable boolean for each state.
vi.mock("~/database/db.server", () => ({
  db: {
    loanAgreementTemplate: { findUnique: vi.fn() },
    loanAgreementSignature: { count: vi.fn() },
  },
}));

import { db } from "~/database/db.server";

import { bookingNeedsAgreementSignature } from "./service.server";

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
