import { beforeEach, describe, expect, it, vi } from "vitest";

// why: stub the DB so the gate's membership lookup returns fixtures, not real rows.
vi.mock("~/database/db.server", () => ({
  db: { userOrganization: { findFirst: vi.fn() } },
}));
// why: stub the Neon client so no real API call is made; toggle configured per test.
vi.mock("~/integrations/neon-crm/client.server", () => ({
  isNeonApiConfigured: vi.fn(() => true),
}));
// why: enforcement now reads the synced allowlist, not a live Neon call — stub the
// allowlist lookups so tests drive "on the list" / "not on the list" / error.
vi.mock("~/modules/big-neon-sync/service.server", () => ({
  isEmailOnNeonAllowlist: vi.fn(),
  findNeonAllowlistMemberByEmail: vi.fn(),
}));
// why: assertMemberCanReserve lives in a module with heavy transitive imports it
// doesn't need here — stub them so the unit under test imports cleanly.
vi.mock("~/modules/user/service.server", () => ({
  createUserOrAttachOrg: vi.fn(),
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: vi.fn(),
}));
vi.mock("~/utils/logger", () => ({ Logger: { error: vi.fn() } }));

import { db } from "~/database/db.server";
import { isNeonApiConfigured } from "~/integrations/neon-crm/client.server";
import { isEmailOnNeonAllowlist } from "~/modules/big-neon-sync/service.server";

import {
  assertMemberCanReserve,
  isMemberReservationEligible,
} from "./service.server";

const ARGS = { userId: "u1", organizationId: "org1" };
const mf = (f: unknown) => f as ReturnType<typeof vi.fn>;
const withMembership = (v: unknown) =>
  mf(db.userOrganization.findFirst).mockResolvedValue(v);
/** A UserOrganization fixture with the given roles + exemption. */
const membership = (roles: string[], exempt = false) => ({
  roles,
  membershipCheckExempt: exempt,
  user: { email: "member@example.org" },
});

describe("assertMemberCanReserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
  });

  it("allows staff (non-MEMBER role) without checking the allowlist", async () => {
    withMembership(membership(["ADMIN"]));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });

  it("allows a user who isn't a member of the workspace", async () => {
    withMembership(null);
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("allows an exempt member without checking the allowlist", async () => {
    withMembership(membership(["MEMBER"], true));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });

  it("allows a member on the synced allowlist", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockResolvedValue(true);
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("blocks a member who is not on the synced allowlist", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockResolvedValue(false);
    await expect(assertMemberCanReserve(ARGS)).rejects.toThrow(/membership/i);
  });

  it("fails OPEN when the allowlist lookup errors (a DB blip must not block members)", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockRejectedValue(new Error("db down"));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("does not block when Neon is unconfigured", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isNeonApiConfigured).mockReturnValue(false);
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });
});

describe("isMemberReservationEligible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
  });

  it("is eligible for staff (non-MEMBER role) without checking the allowlist", async () => {
    withMembership(membership(["ADMIN"]));
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });

  it("is eligible for a user who isn't a member of the workspace", async () => {
    withMembership(null);
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
  });

  it("is eligible for an exempt member without checking the allowlist", async () => {
    withMembership(membership(["MEMBER"], true));
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });

  it("is eligible for a member on the synced allowlist", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockResolvedValue(true);
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
  });

  it("is INELIGIBLE for a member not on the synced allowlist", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockResolvedValue(false);
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(false);
  });

  it("fails OPEN (eligible) when the allowlist lookup errors", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isEmailOnNeonAllowlist).mockRejectedValue(new Error("db down"));
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
  });

  it("is eligible when Neon is unconfigured", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isNeonApiConfigured).mockReturnValue(false);
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
    expect(isEmailOnNeonAllowlist).not.toHaveBeenCalled();
  });
});
