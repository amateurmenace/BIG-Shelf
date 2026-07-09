import { beforeEach, describe, expect, it, vi } from "vitest";

// why: capture the tx handle the transaction callback receives so we can assert
// which deleteMany/createMany calls the sync made, without a real DB.
const tx = {
  neonAllowlistMember: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
};

// why: stub the DB — $transaction just runs the callback with our fake tx
// (ignoring the options arg the real code passes).
vi.mock("~/database/db.server", () => ({
  db: {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    neonAllowlistMember: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));
// why: stub the Neon client so no real API call is made; drive the member list.
vi.mock("~/integrations/neon-crm/client.server", () => ({
  isNeonApiConfigured: vi.fn(() => true),
  listActiveNeonMembers: vi.fn(),
}));

import {
  isNeonApiConfigured,
  listActiveNeonMembers,
} from "~/integrations/neon-crm/client.server";

import { syncNeonAllowlist } from "./service.server";

const mf = (f: unknown) => f as ReturnType<typeof vi.fn>;
/** A NeonMember fixture as the client returns it. */
const member = (email: string | null, id = "1") => ({
  neonAccountId: id,
  email,
  firstName: "Jane",
  lastName: "Doe",
  isActiveMember: true,
});

describe("syncNeonAllowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
  });

  it("clears the table and bulk-inserts the current active set", async () => {
    mf(listActiveNeonMembers).mockResolvedValue([
      member("Alice@Example.com", "1"),
      member("bob@example.com", "2"),
    ]);

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 2 });
    // Whole table is cleared, then the current set is inserted (no per-row round-trip).
    expect(tx.neonAllowlistMember.deleteMany).toHaveBeenCalledWith({});
    const createArgs = tx.neonAllowlistMember.createMany.mock.calls[0][0];
    // Emails are normalized (trimmed + lowercased) as the unique key.
    expect(createArgs.data.map((r: { email: string }) => r.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(createArgs.skipDuplicates).toBe(true);
  });

  it("dedupes members that share an email (case-insensitively)", async () => {
    mf(listActiveNeonMembers).mockResolvedValue([
      member("dup@example.com", "1"),
      member("DUP@example.com", "2"),
    ]);

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 1 });
    expect(
      tx.neonAllowlistMember.createMany.mock.calls[0][0].data
    ).toHaveLength(1);
  });

  it("skips members with no email", async () => {
    mf(listActiveNeonMembers).mockResolvedValue([
      member("has@example.com", "1"),
      member(null, "2"),
    ]);

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 1 });
    expect(
      tx.neonAllowlistMember.createMany.mock.calls[0][0].data
    ).toHaveLength(1);
  });

  it("clears the whole table when Neon returns no active members", async () => {
    mf(listActiveNeonMembers).mockResolvedValue([]);

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 0 });
    // Table is still cleared; nothing is inserted.
    expect(tx.neonAllowlistMember.deleteMany).toHaveBeenCalledWith({});
    expect(tx.neonAllowlistMember.createMany).not.toHaveBeenCalled();
  });

  it("throws (and never calls Neon) when the API isn't configured", async () => {
    mf(isNeonApiConfigured).mockReturnValue(false);
    await expect(syncNeonAllowlist()).rejects.toThrow(/not set/i);
    expect(listActiveNeonMembers).not.toHaveBeenCalled();
  });
});
