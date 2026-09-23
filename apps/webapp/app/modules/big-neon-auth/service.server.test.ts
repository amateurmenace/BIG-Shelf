import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// why: stub the DB so the gate's membership lookup returns fixtures, not real rows.
vi.mock("~/database/db.server", () => ({
  db: { userOrganization: { findFirst: vi.fn() }, user: { update: vi.fn() } },
}));
// why: which workspace Neon members join is configuration, unset in tests.
vi.mock("~/utils/env", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NEON_MEMBER_ORG_ID: "org-big",
}));
// why: record creation has its own tests; here we check sign-in asks for it.
vi.mock("~/modules/big-member-directory/service.server", () => ({
  ensureMemberRecordBestEffort: vi.fn(),
}));
// why: stub the Neon client so no real API call is made; toggle configured per test.
vi.mock("~/integrations/neon-crm/client.server", () => ({
  isNeonApiConfigured: vi.fn(() => true),
}));
// why: enforcement reads the synced allowlist first, then (only on the deny path)
// checks whether that allowlist is even trustworthy and falls back to a live Neon
// lookup — stub all three so tests can drive each branch.
vi.mock("~/modules/big-neon-sync/service.server", () => ({
  isEmailOnNeonAllowlist: vi.fn(),
  findNeonAllowlistMemberByEmail: vi.fn(),
  isAllowlistTrustworthy: vi.fn(),
  refreshAllowlistMemberFromNeon: vi.fn(),
}));
// why: assertMemberCanReserve lives in a module with heavy transitive imports it
// doesn't need here — stub them so the unit under test imports cleanly.
// findUserByEmail is the signal assertActiveNeonMemberForOtp uses to decide
// whether an OTP is really a signup, so tests drive it directly.
vi.mock("~/modules/user/service.server", () => ({
  createUserOrAttachOrg: vi.fn(),
  findUserByEmail: vi.fn(),
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: vi.fn(),
}));
vi.mock("~/utils/logger", () => ({ Logger: { error: vi.fn() } }));

import { db } from "~/database/db.server";
import { isNeonApiConfigured } from "~/integrations/neon-crm/client.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { ensureMemberRecordBestEffort } from "~/modules/big-member-directory/service.server";
import {
  findNeonAllowlistMemberByEmail,
  isAllowlistTrustworthy,
  isEmailOnNeonAllowlist,
  refreshAllowlistMemberFromNeon,
} from "~/modules/big-neon-sync/service.server";
import {
  createUserOrAttachOrg,
  findUserByEmail,
} from "~/modules/user/service.server";

import {
  assertActiveNeonMemberForOtp,
  assertMemberCanReserve,
  findActiveMemberWithoutAccount,
  isMemberReservationEligible,
  provisionAndMintNeonSession,
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

/**
 * The default world: the allowlist is fresh, and Neon (asked live, on the deny
 * path) confirms the person is NOT an active member. This is the only state in
 * which the gate is allowed to deny anyone.
 */
const withHealthyAllowlist = () => {
  mf(isAllowlistTrustworthy).mockResolvedValue(true);
  mf(refreshAllowlistMemberFromNeon).mockResolvedValue(null);
};

describe("assertMemberCanReserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
    withHealthyAllowlist();
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

  it("blocks a member only when the allowlist is fresh AND Neon confirms they're inactive", async () => {
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

/**
 * The regression suite for the July 2026 lockout: Neon revoked BIG's API key, the
 * nightly sync failed silently for four days, and this gate went on denying every
 * member who joined in the meantime. A membership check that cannot verify
 * membership must not deny it.
 */
describe("isMemberReservationEligible — a broken sync must not lock members out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
    withHealthyAllowlist();
    withMembership(membership(["MEMBER"]));
    // Not on the list — every test below is on the deny path.
    mf(isEmailOnNeonAllowlist).mockResolvedValue(false);
  });

  it("is eligible when the allowlist is stale/empty (the sync is broken)", async () => {
    mf(isAllowlistTrustworthy).mockResolvedValue(false);

    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
    // A list we don't trust is never worth a live call, let alone a denial.
    expect(refreshAllowlistMemberFromNeon).not.toHaveBeenCalled();
  });

  it("is eligible for someone who joined Neon since the last sync (live fallback)", async () => {
    mf(refreshAllowlistMemberFromNeon).mockResolvedValue({
      email: "member@example.org",
    });

    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
    expect(refreshAllowlistMemberFromNeon).toHaveBeenCalledWith(
      "member@example.org"
    );
  });

  it("is eligible when Neon itself is unreachable (couldn't verify ≠ not a member)", async () => {
    mf(refreshAllowlistMemberFromNeon).mockRejectedValue(
      new Error("Api key is invalid.")
    );

    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(true);
  });

  it("is INELIGIBLE only when the list is fresh and Neon confirms they're not active", async () => {
    await expect(isMemberReservationEligible(ARGS)).resolves.toBe(false);
  });
});

describe("isMemberReservationEligible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
    withHealthyAllowlist();
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

  it("is INELIGIBLE for a member not on the synced allowlist (and not in Neon)", async () => {
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

/**
 * Regression suite for the OTP signup-gate bypass.
 *
 * The membership check used to hang off the `mode` field posted by the form, so
 * /login's "Continue with OTP" button (which posts mode=login) minted a real
 * account for anyone — Supabase's OTP flow creates an account for an unknown
 * email regardless of what the client called the request. The gate now decides
 * from the DATABASE: no Shelf user for this email means the OTP will CREATE one,
 * which is a signup whatever the form said.
 */
describe("assertActiveNeonMemberForOtp — `mode` is not to be trusted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
    mf(isAllowlistTrustworthy).mockResolvedValue(true);
  });

  it("blocks a non-member whose OTP would MINT a new account (the bypass)", async () => {
    // No Shelf user → this OTP creates one → it is a signup, whatever /login said.
    mf(findUserByEmail).mockResolvedValue(null);
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue(null);
    mf(refreshAllowlistMemberFromNeon).mockResolvedValue(null);

    await expect(
      assertActiveNeonMemberForOtp("stranger@example.com")
    ).rejects.toThrow(/membership/i);
  });

  it("lets an EXISTING user log in without re-checking membership", async () => {
    mf(findUserByEmail).mockResolvedValue({ id: "u1" });

    await expect(
      assertActiveNeonMemberForOtp("existing@example.com")
    ).resolves.toBeUndefined();
    // A genuine login creates nothing — the signup gate must not fire.
    expect(findNeonAllowlistMemberByEmail).not.toHaveBeenCalled();
  });

  it("lets a brand-new ACTIVE member sign up via OTP", async () => {
    mf(findUserByEmail).mockResolvedValue(null);
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue({
      email: "new@example.com",
    });

    await expect(
      assertActiveNeonMemberForOtp("new@example.com")
    ).resolves.toBeUndefined();
  });

  it("does not gate when Neon is unconfigured", async () => {
    mf(isNeonApiConfigured).mockReturnValue(false);

    await expect(
      assertActiveNeonMemberForOtp("anyone@example.com")
    ).resolves.toBeUndefined();
    expect(findUserByEmail).not.toHaveBeenCalled();
  });
});

describe("findActiveMemberWithoutAccount (kiosk walk-up, no account)", () => {
  const ROW = {
    id: "row-1",
    email: "ava@example.com",
    firstName: "Ava",
    lastName: "Whitfield",
    neonAccountId: "9001",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds a paid-up member in the synced directory without asking Neon", async () => {
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue(ROW);

    await expect(
      findActiveMemberWithoutAccount("ava@example.com")
    ).resolves.toEqual(ROW);
    expect(refreshAllowlistMemberFromNeon).not.toHaveBeenCalled();
  });

  it("asks Neon live before refusing someone missing from the last sync", async () => {
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue(null);
    mf(refreshAllowlistMemberFromNeon).mockResolvedValue(ROW);

    await expect(
      findActiveMemberWithoutAccount("ava@example.com")
    ).resolves.toEqual(ROW);
  });

  it("returns null only when Neon confirms they are not an active member", async () => {
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue(null);
    mf(refreshAllowlistMemberFromNeon).mockResolvedValue(null);

    await expect(
      findActiveMemberWithoutAccount("lapsed@example.com")
    ).resolves.toBeNull();
  });

  it("says 'ask staff' — never 'not a member' — when Neon can't be reached", async () => {
    mf(findNeonAllowlistMemberByEmail).mockResolvedValue(null);
    mf(refreshAllowlistMemberFromNeon).mockRejectedValue(
      new Error("Neon is down")
    );

    await expect(
      findActiveMemberWithoutAccount("maybe@example.com")
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("ask a member of staff"),
    });
  });
});

describe("provisionAndMintNeonSession (Log in with Neon)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(createUserOrAttachOrg).mockResolvedValue({ id: "u-ava" });
    mf(db.user.update).mockResolvedValue({ id: "u-ava" });
    // A Supabase that hands back a session for the magic link.
    mf(getSupabaseAdmin).mockReturnValue({
      auth: {
        admin: {
          generateLink: vi.fn().mockResolvedValue({
            data: { properties: { hashed_token: "hash" } },
            error: null,
          }),
        },
        verifyOtp: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
              expires_at: 1,
              user: { id: "u-ava", email: "ava@example.com" },
            },
          },
          error: null,
        }),
      },
    });
  });

  it("joins them to BIG and gives them their record — after stamping their Neon id", async () => {
    const { organizationId } = await provisionAndMintNeonSession({
      neonAccountId: "9001",
      email: "Ava@Example.com",
      firstName: "Ava",
      lastName: "Whitfield",
      isActiveMember: true,
    });

    expect(organizationId).toBe("org-big");
    expect(createUserOrAttachOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ava@example.com",
        organizationId: "org-big",
        roles: [OrganizationRoles.MEMBER],
      })
    );
    expect(ensureMemberRecordBestEffort).toHaveBeenCalledWith({
      organizationId: "org-big",
      userId: "u-ava",
    });
    // The Neon id must be on the account first, so a record staff made under
    // another of their Neon emails is still found.
    expect(mf(db.user.update).mock.invocationCallOrder[0]).toBeLessThan(
      mf(ensureMemberRecordBestEffort).mock.invocationCallOrder[0]
    );
  });

  it("gives an inactive member nothing at all", async () => {
    await expect(
      provisionAndMintNeonSession({
        neonAccountId: "9001",
        email: "ava@example.com",
        firstName: "Ava",
        lastName: "Whitfield",
        isActiveMember: false,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(ensureMemberRecordBestEffort).not.toHaveBeenCalled();
  });
});
