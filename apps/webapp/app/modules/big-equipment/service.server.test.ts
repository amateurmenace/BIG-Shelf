/**
 * Tests for the scan resolver — the org-scoping here is what stops a member
 * from pulling up another workspace's asset by scanning a foreign label.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// why: stub the DB so lookups return fixtures, not real rows.
vi.mock("~/database/db.server", () => ({
  db: {
    qr: { findFirst: vi.fn() },
    barcode: { findFirst: vi.fn() },
    asset: { findFirst: vi.fn(), count: vi.fn() },
    assetGuide: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
// why: the module imports the booking service (heavy transitive imports) for
// the order composition; the resolver under test never touches it.
vi.mock("../booking/service.server", () => ({
  createBooking: vi.fn(),
  reserveBooking: vi.fn(),
  deleteBooking: vi.fn(),
}));

import { db } from "~/database/db.server";
import { resolveScannedCode } from "./service.server";

const mf = (f: unknown) => f as ReturnType<typeof vi.fn>;
const ORG = "org1";

describe("resolveScannedCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a QR id to its asset (org-scoped)", async () => {
    mf(db.qr.findFirst).mockResolvedValue({ assetId: "a1", kitId: null });
    await expect(
      resolveScannedCode({ organizationId: ORG, value: "qr123", type: "qr" })
    ).resolves.toEqual({ kind: "asset", assetId: "a1" });
    expect(mf(db.qr.findFirst).mock.calls[0][0].where).toMatchObject({
      id: "qr123",
      organizationId: ORG,
    });
  });

  it("reports a kit QR as a kit (not bookable via the member scanner)", async () => {
    mf(db.qr.findFirst).mockResolvedValue({ assetId: null, kitId: "k1" });
    await expect(
      resolveScannedCode({ organizationId: ORG, value: "qr123", type: "qr" })
    ).resolves.toEqual({ kind: "kit" });
  });

  it("returns not-found for a foreign org's QR (org scoping)", async () => {
    mf(db.qr.findFirst).mockResolvedValue(null);
    await expect(
      resolveScannedCode({ organizationId: ORG, value: "qr999", type: "qr" })
    ).resolves.toEqual({ kind: "not-found" });
  });

  it("resolves a barcode value to its asset", async () => {
    mf(db.barcode.findFirst).mockResolvedValue({ assetId: "a2", kitId: null });
    await expect(
      resolveScannedCode({
        organizationId: ORG,
        value: "BC-001",
        type: "barcode",
      })
    ).resolves.toEqual({ kind: "asset", assetId: "a2" });
  });

  it("resolves a SAM id to its asset", async () => {
    mf(db.asset.findFirst).mockResolvedValue({ id: "a3" });
    await expect(
      resolveScannedCode({
        organizationId: ORG,
        value: "SAM-0042",
        type: "samId",
      })
    ).resolves.toEqual({ kind: "asset", assetId: "a3" });
  });

  it("returns not-found for blank input without querying", async () => {
    await expect(
      resolveScannedCode({ organizationId: ORG, value: "   ", type: "qr" })
    ).resolves.toEqual({ kind: "not-found" });
    expect(db.qr.findFirst).not.toHaveBeenCalled();
  });
});
