import { beforeEach, describe, expect, it, vi } from "vitest";

// why: stub the DB so the gate's membership lookup returns fixtures, not real rows.
vi.mock("~/database/db.server", () => ({
  db: { userOrganization: { findFirst: vi.fn() } },
}));
// why: stub the Neon client so no real API call is made; toggle configured/active per test.
vi.mock("~/integrations/neon-crm/client.server", () => ({
  isNeonApiConfigured: vi.fn(() => true),
  resolveNeonMemberByEmail: vi.fn(),
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
import {
  isNeonApiConfigured,
  resolveNeonMemberByEmail,
} from "~/integrations/neon-crm/client.server";

import { assertMemberCanReserve } from "./service.server";

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

  it("allows staff (non-MEMBER role) without a Neon check", async () => {
    withMembership(membership(["ADMIN"]));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(resolveNeonMemberByEmail).not.toHaveBeenCalled();
  });

  it("allows a user who isn't a member of the workspace", async () => {
    withMembership(null);
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("allows an exempt member without checking Neon", async () => {
    withMembership(membership(["MEMBER"], true));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(resolveNeonMemberByEmail).not.toHaveBeenCalled();
  });

  it("allows a currently-active Neon member", async () => {
    withMembership(membership(["MEMBER"]));
    mf(resolveNeonMemberByEmail).mockResolvedValue({ isActiveMember: true });
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("blocks a member whose Neon membership is not active", async () => {
    withMembership(membership(["MEMBER"]));
    mf(resolveNeonMemberByEmail).mockResolvedValue({ isActiveMember: false });
    await expect(assertMemberCanReserve(ARGS)).rejects.toThrow(/membership/i);
  });

  it("blocks a member with no matching Neon record", async () => {
    withMembership(membership(["MEMBER"]));
    mf(resolveNeonMemberByEmail).mockResolvedValue(null);
    await expect(assertMemberCanReserve(ARGS)).rejects.toThrow();
  });

  it("fails OPEN when the Neon API errors (an outage must not block members)", async () => {
    withMembership(membership(["MEMBER"]));
    mf(resolveNeonMemberByEmail).mockRejectedValue(new Error("Neon 500"));
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
  });

  it("does not block when Neon is unconfigured", async () => {
    withMembership(membership(["MEMBER"]));
    mf(isNeonApiConfigured).mockReturnValue(false);
    await expect(assertMemberCanReserve(ARGS)).resolves.toBeUndefined();
    expect(resolveNeonMemberByEmail).not.toHaveBeenCalled();
  });
});
