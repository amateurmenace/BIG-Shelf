import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { verifyOtpAndSignin } from "~/modules/auth/service.server";
import { ensureMemberRecordBestEffort } from "~/modules/big-member-directory/service.server";
import {
  assertActiveNeonMemberForSignup,
  linkNeonAccountByEmail,
} from "~/modules/big-neon-auth/service.server";
import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import { createUser, findUserByEmail } from "~/modules/user/service.server";
import { action } from "~/routes/_auth+/otp";

const env = vi.hoisted(() => ({
  NEON_MEMBER_ORG_ID: "org-big" as string | undefined,
}));

// why: which workspace members join is configuration; tests switch it per case.
vi.mock("~/utils/env", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get NEON_MEMBER_ORG_ID() {
    return env.NEON_MEMBER_ORG_ID;
  },
}));

// why: verifying a real one-time code needs Supabase; the code is not under test.
vi.mock("~/modules/auth/service.server", () => ({
  verifyOtpAndSignin: vi.fn(),
}));

// why: account creation writes to the database; we only check WHAT is created.
vi.mock("~/modules/user/service.server", () => ({
  createUser: vi.fn(),
  findUserByEmail: vi.fn(),
}));

// why: username generation queries the database for collisions.
vi.mock("~/modules/user/utils.server", () => ({
  generateUniqueUsername: vi.fn().mockResolvedValue("new-member"),
}));

// why: the membership gate calls Neon; each test decides the answer.
vi.mock("~/modules/big-neon-auth/service.server", () => ({
  assertActiveNeonMemberForSignup: vi.fn(),
  linkNeonAccountByEmail: vi.fn(),
}));

// why: record creation has its own tests; here we check it is (or isn't) asked.
vi.mock("~/modules/big-member-directory/service.server", () => ({
  ensureMemberRecordBestEffort: vi.fn(),
}));

// why: workspace selection reads cookies and the database.
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: vi.fn(),
  setSelectedOrganizationIdCookie: vi.fn(
    async (id: string) => `selected-org=${id}`
  ),
}));

const NEON_ROW = {
  id: "row-1",
  email: "ava@example.com",
  firstName: "Ava",
  lastName: "Whitfield",
  neonAccountId: "9001",
  syncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

function submitCode() {
  const body = new FormData();
  body.set("email", "ava@example.com");
  body.set("otp", "123456");
  return action(
    createActionArgs({
      request: new Request("http://localhost:3000/otp", {
        method: "POST",
        body,
      }),
      context: { setSession: vi.fn() } as any,
    })
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  env.NEON_MEMBER_ORG_ID = "org-big";
  vi.mocked(verifyOtpAndSignin).mockResolvedValue({
    userId: "u-ava",
    email: "ava@example.com",
  } as any);
  vi.mocked(findUserByEmail).mockResolvedValue(null);
  vi.mocked(getSelectedOrganization).mockResolvedValue({
    organizationId: "org-personal",
  } as any);
});

describe("email sign-up (OTP) for a Neon member", () => {
  it("joins them to the member workspace, gives them their record, and lands them there", async () => {
    vi.mocked(assertActiveNeonMemberForSignup).mockResolvedValue(NEON_ROW);

    const response = await submitCode();

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-big",
        roles: [OrganizationRoles.MEMBER],
      })
    );
    expect(ensureMemberRecordBestEffort).toHaveBeenCalledWith({
      organizationId: "org-big",
      userId: "u-ava",
    });
    // The Neon account id is stamped first, so a secondary email still
    // finds a record staff made under their main one.
    expect(
      vi.mocked(linkNeonAccountByEmail).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(ensureMemberRecordBestEffort).mock.invocationCallOrder[0]
    );
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith("org-big");
    expect(getSelectedOrganization).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
  });

  it("keeps the old personal-workspace behaviour when Neon isn't configured", async () => {
    vi.mocked(assertActiveNeonMemberForSignup).mockResolvedValue(null);

    await submitCode();

    const created = vi.mocked(createUser).mock.calls[0][0];
    expect(created).not.toHaveProperty("organizationId");
    expect(created).not.toHaveProperty("roles");
    expect(ensureMemberRecordBestEffort).not.toHaveBeenCalled();
    expect(setSelectedOrganizationIdCookie).toHaveBeenCalledWith(
      "org-personal"
    );
  });

  it("keeps it too when no member workspace is set up", async () => {
    vi.mocked(assertActiveNeonMemberForSignup).mockResolvedValue(NEON_ROW);
    env.NEON_MEMBER_ORG_ID = undefined;

    await submitCode();

    expect(vi.mocked(createUser).mock.calls[0][0]).not.toHaveProperty(
      "organizationId"
    );
    expect(ensureMemberRecordBestEffort).not.toHaveBeenCalled();
  });

  it("leaves existing accounts alone — logging in creates nothing", async () => {
    vi.mocked(findUserByEmail).mockResolvedValue({ id: "u-ava" } as any);

    await submitCode();

    expect(assertActiveNeonMemberForSignup).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(ensureMemberRecordBestEffort).not.toHaveBeenCalled();
  });
});
