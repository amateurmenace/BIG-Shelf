import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import {
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
