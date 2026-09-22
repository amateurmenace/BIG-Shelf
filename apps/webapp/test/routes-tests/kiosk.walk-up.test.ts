import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { db } from "~/database/db.server";
import { resolveReservationCustodian } from "~/modules/big-member-directory/service.server";
import {
  findActiveMemberWithoutAccount,
  isMemberReservationEligible,
} from "~/modules/big-neon-auth/service.server";
import {
  createRoomReservation,
  findOrgMemberByEmail,
} from "~/modules/big-room-booking/service.server";
import { action } from "~/routes/kiosk";
import { ShelfError } from "~/utils/error";
import { requirePermission } from "~/utils/roles.server";

// why: the kiosk device's own permission check is not under test; it is signed
// in as staff in every case here.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: the only table the action reads directly is Room; no test database.
vi.mock("~/database/db.server", () => ({
  db: { room: { findFirst: vi.fn() } },
}));

// why: booking itself (conflicts, emails, calendar) is covered elsewhere — here
// we only need to see WHO the action books for, and whether it books at all.
vi.mock("~/modules/big-room-booking/service.server", () => ({
  findOrgMemberByEmail: vi.fn(),
  createRoomReservation: vi.fn(),
  getRoomsWithSchedule: vi.fn(),
  getWeekAheadDigest: vi.fn(),
}));

// why: membership rules have their own tests; these drive each outcome.
vi.mock("~/modules/big-neon-auth/service.server", () => ({
  isMemberReservationEligible: vi.fn(),
  findActiveMemberWithoutAccount: vi.fn(),
}));

// why: record creation has its own tests; here we check it is (or isn't) asked.
vi.mock("~/modules/big-member-directory/service.server", () => ({
  resolveReservationCustodian: vi.fn(),
}));

const findMember = vi.mocked(findOrgMemberByEmail);
const findDirectory = vi.mocked(findActiveMemberWithoutAccount);
const isEligible = vi.mocked(isMemberReservationEligible);
const resolveCustodian = vi.mocked(resolveReservationCustodian);
const reserve = vi.mocked(createRoomReservation);

const DIRECTORY_ROW = {
  id: "row-1",
  email: "ava@example.com",
  firstName: "Ava",
  lastName: "Whitfield",
  neonAccountId: "9001",
  syncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Posts the walk-up form; the slot defaults to tomorrow so it's never past. */
function walkUp({
  email = "Ava@Example.com",
  start = DateTime.now().plus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
} = {}) {
  const body = new FormData();
  body.set("intent", "walk-up-book");
  body.set("roomId", "room-1");
  body.set("email", email);
  body.set("start", start);
  body.set("durationMinutes", "60");

  return action(
    createActionArgs({
      request: new Request("http://localhost:3000/kiosk", {
        method: "POST",
        body,
      }),
      context: { getSession: () => ({ userId: "kiosk-staff" }) } as any,
    })
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    organizationId: "org-big",
    currentOrganization: { id: "org-big", type: "TEAM" },
    isSelfServiceOrBase: false,
  } as any);
  vi.mocked(db.room.findFirst).mockResolvedValue({
    id: "room-1",
    name: "Studio A",
  } as any);
  reserve.mockResolvedValue({} as any);
});

describe("kiosk walk-up booking", () => {
  it("books a paid-up member who has never signed in, without promising an email", async () => {
    findMember.mockResolvedValue(null);
    findDirectory.mockResolvedValue(DIRECTORY_ROW);
    resolveCustodian.mockResolvedValue({
      id: "tm-ava",
      userId: null,
      name: "Ava Whitfield",
    });

    const response = await walkUp();

    expect(resolveCustodian).toHaveBeenCalledWith({
      organizationId: "org-big",
      custodianId: "neon:ava@example.com",
      allowDirectory: true,
    });
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        custodianTeamMemberId: "tm-ava",
        custodianUserId: null,
        creatorId: "kiosk-staff",
      })
    );
    expect(response.data).toMatchObject({
      ok: true,
      confirmation: { firstName: "Ava", emailSent: false },
    });
  });

  it("still sends a lapsed member to the sign-up screen — and creates nothing", async () => {
    findMember.mockResolvedValue(null);
    findDirectory.mockResolvedValue(null);

    const response = await walkUp({ email: "lapsed@example.com" });

    expect(response.data).toMatchObject({ ok: false, needsMembership: true });
    expect(resolveCustodian).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("asks them to see staff, not to join, when Neon can't be reached", async () => {
    findMember.mockResolvedValue(null);
    findDirectory.mockRejectedValue(
      new ShelfError({
        cause: null,
        message:
          "We couldn't confirm your membership just now. Please ask a member of staff to book this for you.",
        status: 503,
        label: "Neon Auth",
      })
    );

    const response = await walkUp();

    expect(response.init?.status).toBe(503);
    expect(response.data.error.message).toContain("ask a member of staff");
    expect(response.data).not.toHaveProperty("needsMembership");
    expect(resolveCustodian).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("creates no record when the booking itself is refused", async () => {
    findMember.mockResolvedValue(null);
    findDirectory.mockResolvedValue(DIRECTORY_ROW);

    const response = await walkUp({
      start: DateTime.now().minus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
    });

    expect(response.init?.status).toBe(400);
    expect(resolveCustodian).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("books account holders exactly as before, and promises them the email", async () => {
    findMember.mockResolvedValue({
      user: {
        id: "u-bea",
        firstName: "Bea",
        lastName: "Jansen",
        email: "bea@example.com",
      },
      teamMember: { id: "tm-bea", name: "Bea Jansen" },
    });
    isEligible.mockResolvedValue(true);

    const response = await walkUp({ email: "bea@example.com" });

    expect(findDirectory).not.toHaveBeenCalled();
    expect(resolveCustodian).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        custodianTeamMemberId: "tm-bea",
        custodianUserId: "u-bea",
      })
    );
    expect(response.data).toMatchObject({
      ok: true,
      confirmation: { firstName: "Bea", emailSent: true },
    });
  });

  it("still refuses an account holder whose membership has lapsed", async () => {
    findMember.mockResolvedValue({
      user: {
        id: "u-old",
        firstName: "Old",
        lastName: "Member",
        email: "old@example.com",
      },
      teamMember: { id: "tm-old", name: "Old Member" },
    });
    isEligible.mockResolvedValue(false);

    const response = await walkUp({ email: "old@example.com" });

    expect(response.data).toMatchObject({ ok: false, needsMembership: true });
    expect(reserve).not.toHaveBeenCalled();
  });
});
