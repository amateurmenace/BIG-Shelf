import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import { Logger } from "~/utils/logger";
import {
  ensureMemberRecord,
  ensureMemberRecordBestEffort,
  listReservablePeople,
  resolveReservationCustodian,
} from "./service.server";

// why: there is no test database; these tests pin the listing and resolution
// RULES (who appears, who wins a tie, what gets created) against fixture rows.
vi.mock("~/database/db.server", () => ({
  db: {
    teamMember: { findMany: vi.fn(), findFirst: vi.fn() },
    neonAllowlistMember: { findMany: vi.fn(), findUnique: vi.fn() },
    memberDirectoryLink: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// why: the sign-in wrapper's whole contract is "log instead of throwing";
// capture the log rather than printing it.
vi.mock("~/utils/logger", () => ({ Logger: { error: vi.fn() } }));

const ORG = "org-big";
const dbMock = vi.mocked(db, true);

/** A transaction client whose writes the tests can inspect. */
const tx = {
  teamMember: { create: vi.fn() },
  memberDirectoryLink: { upsert: vi.fn() },
};

/** A team member row as `listReservablePeople` selects it. */
function teamMemberRow(overrides: {
  id: string;
  name: string;
  userId?: string | null;
  user?: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
  } | null;
  directoryLink?: { email: string } | null;
}) {
  return {
    userId: null,
    user: null,
    directoryLink: null,
    ...overrides,
    ...(overrides.user
      ? {
          user: {
            firstName: null,
            lastName: null,
            displayName: null,
            ...overrides.user,
          },
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(((callback: any) =>
    callback(tx)) as any);
});

describe("listReservablePeople", () => {
  it("lists staff, members, account-less records AND every Neon member not already present", async () => {
    dbMock.teamMember.findMany.mockResolvedValue([
      teamMemberRow({
        id: "tm-admin",
        name: "stale name",
        userId: "u-admin",
        user: { email: "Dee@Example.org", firstName: "Dee", lastName: "Admin" },
      }),
      teamMemberRow({ id: "tm-org", name: "Brookline Interactive Group" }),
    ] as any);
    dbMock.neonAllowlistMember.findMany.mockResolvedValue([
      { email: "ava@example.com", firstName: "Ava", lastName: "Whitfield" },
      { email: "nameless@example.com", firstName: null, lastName: null },
    ] as any);

    const people = await listReservablePeople({ organizationId: ORG });

    expect(people).toEqual([
      {
        id: "neon:ava@example.com",
        name: "Ava Whitfield",
        email: "ava@example.com",
        userId: null,
        hasAccount: false,
      },
      {
        id: "tm-org",
        name: "Brookline Interactive Group",
        email: null,
        userId: null,
        hasAccount: false,
      },
      {
        // The account's own name wins over the record's stale one.
        id: "tm-admin",
        name: "Dee Admin",
        email: "dee@example.org",
        userId: "u-admin",
        hasAccount: true,
      },
      {
        // No name in Neon → falls back to the email, still reservable.
        id: "neon:nameless@example.com",
        name: "nameless@example.com",
        email: "nameless@example.com",
        userId: null,
        hasAccount: false,
      },
    ]);
  });

  it("scopes team members to the caller's organization", async () => {
    dbMock.teamMember.findMany.mockResolvedValue([]);
    dbMock.neonAllowlistMember.findMany.mockResolvedValue([]);

    await listReservablePeople({ organizationId: ORG });

    expect(dbMock.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, deletedAt: null },
      })
    );
  });

  it("shows a Neon member only once when they already have a record", async () => {
    dbMock.teamMember.findMany.mockResolvedValue([
      // Signed up: their account record.
      teamMemberRow({
        id: "tm-account",
        name: "Bea Jansen",
        userId: "u-bea",
        user: {
          email: "bea@example.com",
          firstName: "Bea",
          lastName: "Jansen",
        },
      }),
      // Reserved for BEFORE they signed up: the older account-less record.
      teamMemberRow({
        id: "tm-linked",
        name: "Bea Jansen",
        directoryLink: { email: "bea@example.com" },
      }),
      // Reserved for, never signed up.
      teamMemberRow({
        id: "tm-dan",
        name: "Dan Lyle",
        directoryLink: { email: "dan@example.com" },
      }),
    ] as any);
    dbMock.neonAllowlistMember.findMany.mockResolvedValue([
      { email: "BEA@example.com", firstName: "Bea", lastName: "Jansen" },
      { email: "dan@example.com", firstName: "Dan", lastName: "Lyle" },
    ] as any);

    const people = await listReservablePeople({ organizationId: ORG });

    expect(people.map((p) => p.id)).toEqual(["tm-account", "tm-dan"]);
  });
});

describe("resolveReservationCustodian", () => {
  it("looks an ordinary id up within the caller's organization only", async () => {
    dbMock.teamMember.findFirst.mockResolvedValue({
      id: "tm-1",
      userId: "u-1",
      name: "Dee",
    } as any);

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "tm-1",
      allowDirectory: true,
    });

    expect(result).toEqual({ id: "tm-1", userId: "u-1", name: "Dee" });
    expect(dbMock.teamMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm-1", organizationId: ORG, deletedAt: null },
      })
    );
  });

  it("404s an id from another organization instead of booking against it", async () => {
    dbMock.teamMember.findFirst.mockResolvedValue(null);

    await expect(
      resolveReservationCustodian({
        organizationId: ORG,
        custodianId: "tm-foreign",
        allowDirectory: true,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a directory pick from a member before touching the database", async () => {
    await expect(
      resolveReservationCustodian({
        organizationId: ORG,
        custodianId: "neon:someone@example.com",
        allowDirectory: false,
      })
    ).rejects.toMatchObject({ status: 403 });

    expect(dbMock.neonAllowlistMember.findUnique).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("404s someone who is no longer in the Neon directory, creating nothing", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue(null);

    await expect(
      resolveReservationCustodian({
        organizationId: ORG,
        custodianId: "neon:lapsed@example.com",
        allowDirectory: true,
      })
    ).rejects.toMatchObject({ status: 404 });

    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("reuses the member's account record when they have one", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue({
      email: "bea@example.com",
      firstName: "Bea",
      lastName: "Jansen",
    } as any);
    dbMock.teamMember.findFirst.mockResolvedValue({
      id: "tm-account",
      userId: "u-bea",
      name: "Bea Jansen",
    } as any);

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "neon:bea@example.com",
      allowDirectory: true,
    });

    expect(result.id).toBe("tm-account");
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("reuses the record made the first time they were reserved for", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue({
      email: "dan@example.com",
      firstName: "Dan",
      lastName: "Lyle",
    } as any);
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.memberDirectoryLink.findUnique.mockResolvedValue({
      teamMember: {
        id: "tm-dan",
        userId: null,
        name: "Dan Lyle",
        deletedAt: null,
      },
    } as any);

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "neon:dan@example.com",
      allowDirectory: true,
    });

    expect(result).toEqual({
      id: "tm-dan",
      userId: null,
      name: "Dan Lyle",
    });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("creates an account-less record plus its link for a first-time pick", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue({
      email: "ava@example.com",
      firstName: "Ava",
      lastName: "Whitfield",
    } as any);
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.memberDirectoryLink.findUnique.mockResolvedValue(null);
    tx.teamMember.create.mockResolvedValue({
      id: "tm-new",
      userId: null,
      name: "Ava Whitfield",
    });

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "neon:Ava@Example.com",
      allowDirectory: true,
    });

    expect(result).toEqual({
      id: "tm-new",
      userId: null,
      name: "Ava Whitfield",
    });
    expect(tx.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "Ava Whitfield", organizationId: ORG },
      })
    );
    expect(tx.memberDirectoryLink.upsert).toHaveBeenCalledWith({
      where: {
        organizationId_email: {
          organizationId: ORG,
          email: "ava@example.com",
        },
      },
      create: {
        organizationId: ORG,
        email: "ava@example.com",
        teamMemberId: "tm-new",
      },
      update: { teamMemberId: "tm-new" },
    });
  });

  it("makes a fresh record when staff had removed the previous one", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue({
      email: "dan@example.com",
      firstName: "Dan",
      lastName: "Lyle",
    } as any);
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    dbMock.memberDirectoryLink.findUnique.mockResolvedValue({
      teamMember: {
        id: "tm-removed",
        userId: null,
        name: "Dan Lyle",
        deletedAt: new Date(),
      },
    } as any);
    tx.teamMember.create.mockResolvedValue({
      id: "tm-fresh",
      userId: null,
      name: "Dan Lyle",
    });

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "neon:dan@example.com",
      allowDirectory: true,
    });

    expect(result.id).toBe("tm-fresh");
    expect(tx.memberDirectoryLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { teamMemberId: "tm-fresh" } })
    );
  });

  it("returns the other request's record when two staff pick the same person at once", async () => {
    dbMock.neonAllowlistMember.findUnique.mockResolvedValue({
      email: "ava@example.com",
      firstName: "Ava",
      lastName: "Whitfield",
    } as any);
    dbMock.teamMember.findFirst.mockResolvedValue(null);
    // Not there when we check; there once the other request has committed.
    dbMock.memberDirectoryLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        teamMember: {
          id: "tm-winner",
          userId: null,
          name: "Ava Whitfield",
          deletedAt: null,
        },
      } as any);
    dbMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const result = await resolveReservationCustodian({
      organizationId: ORG,
      custodianId: "neon:ava@example.com",
      allowDirectory: true,
    });

    expect(result.id).toBe("tm-winner");
  });
});

describe("ensureMemberRecord — the record a member's account needs", () => {
  /** Everything the function touches runs inside this transaction client. */
  const ensureTx = {
    $executeRaw: vi.fn(),
    teamMember: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    user: { findUniqueOrThrow: vi.fn() },
    neonAllowlistMember: { findMany: vi.fn() },
    memberDirectoryLink: { findMany: vi.fn() },
    booking: { updateMany: vi.fn() },
  };

  const ACCOUNT = {
    email: "ava@example.com",
    firstName: "Ava",
    lastName: "Whitfield",
    displayName: null,
    neonAccountId: null as string | null,
  };

  /** A directory link row as the function selects it. */
  function link(
    email: string,
    teamMember: { id: string; userId?: string | null; deletedAt?: Date | null }
  ) {
    return {
      email,
      teamMember: { userId: null, deletedAt: null, ...teamMember },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$transaction.mockImplementation(((callback: any) =>
      callback(ensureTx)) as any);
    ensureTx.teamMember.findFirst.mockResolvedValue(null);
    ensureTx.user.findUniqueOrThrow.mockResolvedValue({ ...ACCOUNT });
    ensureTx.neonAllowlistMember.findMany.mockResolvedValue([]);
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([]);
    ensureTx.booking.updateMany.mockResolvedValue({ count: 0 });
    ensureTx.teamMember.create.mockImplementation(({ data }: any) => ({
      id: "tm-new",
      userId: data.userId,
      name: data.name,
    }));
    ensureTx.teamMember.update.mockImplementation(({ where, data }: any) => ({
      id: where.id,
      userId: data.userId,
      name: data.name,
    }));
  });

  it("leaves someone who already has a record alone", async () => {
    ensureTx.teamMember.findFirst.mockResolvedValue({
      id: "tm-ava",
      userId: "u-ava",
      name: "Ava Whitfield",
    });

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(result).toMatchObject({ id: "tm-ava", outcome: "existing" });
    expect(ensureTx.teamMember.create).not.toHaveBeenCalled();
    expect(ensureTx.teamMember.update).not.toHaveBeenCalled();
    expect(ensureTx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("takes a per-person lock before looking, so two first logins can't both create one", async () => {
    await ensureMemberRecord({ organizationId: ORG, userId: "u-ava" });

    const [, key] = ensureTx.$executeRaw.mock.calls[0];
    expect(key).toBe("member-record:org-big:u-ava");
    expect(ensureTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      ensureTx.teamMember.findFirst.mock.invocationCallOrder[0]
    );
  });

  it("takes over the record staff booked on, so those reservations become theirs", async () => {
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([
      link("ava@example.com", { id: "tm-booked" }),
    ]);
    ensureTx.booking.updateMany.mockResolvedValue({ count: 3 });

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(result).toEqual({
      id: "tm-booked",
      userId: "u-ava",
      name: "Ava Whitfield",
      outcome: "adopted",
      movedBookings: 3,
    });
    expect(ensureTx.teamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm-booked", organizationId: ORG },
        data: { userId: "u-ava", name: "Ava Whitfield" },
      })
    );
    expect(ensureTx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        custodianTeamMemberId: "tm-booked",
        custodianUserId: null,
      },
      data: { custodianUserId: "u-ava" },
    });
    expect(ensureTx.teamMember.create).not.toHaveBeenCalled();
  });

  it("finds it when they sign up with another email on the same Neon account", async () => {
    ensureTx.user.findUniqueOrThrow.mockResolvedValue({
      ...ACCOUNT,
      email: "Ava.Work@Example.com",
      neonAccountId: "9001",
    });
    ensureTx.neonAllowlistMember.findMany.mockResolvedValue([
      { email: "ava@example.com" },
      { email: "ava.work@example.com" },
    ]);
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([
      link("ava@example.com", { id: "tm-booked" }),
    ]);

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(ensureTx.neonAllowlistMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { neonAccountId: "9001" } })
    );
    const { where } = ensureTx.memberDirectoryLink.findMany.mock.calls[0][0];
    expect(where.email.in).toEqual(
      expect.arrayContaining(["ava.work@example.com", "ava@example.com"])
    );
    expect(result).toMatchObject({ id: "tm-booked", outcome: "adopted" });
  });

  it("prefers the record made under the email they signed up with", async () => {
    ensureTx.user.findUniqueOrThrow.mockResolvedValue({
      ...ACCOUNT,
      neonAccountId: "9001",
    });
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([
      link("ava.other@example.com", { id: "tm-other" }),
      link("ava@example.com", { id: "tm-login" }),
    ]);

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(result.id).toBe("tm-login");
  });

  it("never takes a record that already belongs to another account", async () => {
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([
      link("ava@example.com", { id: "tm-taken", userId: "u-someone-else" }),
    ]);

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(ensureTx.teamMember.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "tm-new", outcome: "created" });
  });

  it("ignores a record staff have removed from the team", async () => {
    ensureTx.memberDirectoryLink.findMany.mockResolvedValue([
      link("ava@example.com", { id: "tm-removed", deletedAt: new Date() }),
    ]);

    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(ensureTx.teamMember.update).not.toHaveBeenCalled();
    expect(result.outcome).toBe("created");
  });

  it("creates a fresh record, named after the account, when nobody booked for them", async () => {
    const result = await ensureMemberRecord({
      organizationId: ORG,
      userId: "u-ava",
    });

    expect(ensureTx.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "Ava Whitfield", organizationId: ORG, userId: "u-ava" },
      })
    );
    expect(result).toMatchObject({ outcome: "created", movedBookings: 0 });
  });

  it("falls back to the email for the name when the account has none", async () => {
    ensureTx.user.findUniqueOrThrow.mockResolvedValue({
      ...ACCOUNT,
      firstName: null,
      lastName: null,
    });

    await ensureMemberRecord({ organizationId: ORG, userId: "u-ava" });

    expect(ensureTx.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "ava@example.com" }),
      })
    );
  });

  it("never blocks a sign-in: the best-effort version logs instead of throwing", async () => {
    dbMock.$transaction.mockRejectedValueOnce(new Error("database blip"));

    await expect(
      ensureMemberRecordBestEffort({ organizationId: ORG, userId: "u-ava" })
    ).resolves.toBeUndefined();
    expect(Logger.error).toHaveBeenCalled();
  });
});
