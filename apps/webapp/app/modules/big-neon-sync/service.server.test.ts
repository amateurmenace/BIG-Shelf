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
// (ignoring the options arg the real code passes). `count` drives the safety
// guards (previous allowlist size) and `neonSyncStatus.upsert` is the sync-health
// bookkeeping, which must never be what breaks a sync.
vi.mock("~/database/db.server", () => ({
  db: {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    neonAllowlistMember: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    neonSyncStatus: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));
// why: stub the Neon client so no real API call is made; drive the member list.
vi.mock("~/integrations/neon-crm/client.server", () => ({
  isNeonApiConfigured: vi.fn(() => true),
  listActiveNeonMembers: vi.fn(),
  resolveNeonMemberByEmail: vi.fn(),
}));

import { db } from "~/database/db.server";
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

/**
 * A complete, self-consistent pull — the shape `listActiveNeonMembers` returns.
 * Tests that care about completeness override the bookkeeping explicitly.
 */
const pull = (
  members: ReturnType<typeof member>[],
  overrides: Partial<{
    totalResults: number | null;
    rowsSeen: number;
    complete: boolean;
  }> = {}
) => ({
  members,
  totalResults: members.length,
  rowsSeen: members.length,
  complete: true,
  ...overrides,
});

/** How many rows the allowlist held before the run (drives the safety guards). */
const withPreviousCount = (n: number) =>
  mf(db.neonAllowlistMember.count).mockResolvedValue(n);

describe("syncNeonAllowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isNeonApiConfigured).mockReturnValue(true);
    withPreviousCount(0);
  });

  it("clears the table and bulk-inserts the current active set", async () => {
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([member("Alice@Example.com", "1"), member("bob@example.com", "2")])
    );

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 2, removedCount: 0 });
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
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([member("dup@example.com", "1"), member("DUP@example.com", "2")])
    );

    const result = await syncNeonAllowlist();

    expect(result.activeCount).toBe(1);
    expect(
      tx.neonAllowlistMember.createMany.mock.calls[0][0].data
    ).toHaveLength(1);
  });

  it("skips members with no email", async () => {
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([member("has@example.com", "1"), member(null, "2")])
    );

    const result = await syncNeonAllowlist();

    expect(result.activeCount).toBe(1);
    expect(
      tx.neonAllowlistMember.createMany.mock.calls[0][0].data
    ).toHaveLength(1);
  });

  it("reports how many members dropped off", async () => {
    withPreviousCount(4);
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([
        member("a@example.com", "1"),
        member("b@example.com", "2"),
        member("c@example.com", "3"),
      ])
    );

    const result = await syncNeonAllowlist();

    expect(result).toEqual({ activeCount: 3, removedCount: 1 });
  });

  // The lockout class of bug: anything MISSING from the pull is deleted from the
  // allowlist and thereby blocked from reserving. These guards make a broken pull
  // a no-op rather than a mass revocation.
  describe("refuses to replace the allowlist with a bad pull", () => {
    it("does not empty the allowlist when Neon returns no active members", async () => {
      withPreviousCount(141);
      mf(listActiveNeonMembers).mockResolvedValue(pull([]));

      await expect(syncNeonAllowlist()).rejects.toThrow(/zero active members/i);
      expect(tx.neonAllowlistMember.deleteMany).not.toHaveBeenCalled();
    });

    it("does not apply a pull that would remove more than half the allowlist", async () => {
      withPreviousCount(141);
      mf(listActiveNeonMembers).mockResolvedValue(
        pull([member("a@example.com", "1"), member("b@example.com", "2")])
      );

      await expect(syncNeonAllowlist()).rejects.toThrow(/more than half/i);
      expect(tx.neonAllowlistMember.deleteMany).not.toHaveBeenCalled();
    });

    it("does not apply a truncated (still-paginating) pull", async () => {
      withPreviousCount(141);
      mf(listActiveNeonMembers).mockResolvedValue(
        pull([member("a@example.com", "1")], { complete: false })
      );

      await expect(syncNeonAllowlist()).rejects.toThrow(/incomplete/i);
      expect(tx.neonAllowlistMember.deleteMany).not.toHaveBeenCalled();
    });

    it("does not apply a pull that read fewer rows than Neon reported", async () => {
      withPreviousCount(141);
      mf(listActiveNeonMembers).mockResolvedValue(
        pull([member("a@example.com", "1")], {
          totalResults: 141,
          rowsSeen: 100,
        })
      );

      await expect(syncNeonAllowlist()).rejects.toThrow(/141|missing/i);
      expect(tx.neonAllowlistMember.deleteMany).not.toHaveBeenCalled();
    });

    it("records the failure so a broken sync is visible, not silent", async () => {
      withPreviousCount(141);
      mf(listActiveNeonMembers).mockResolvedValue(pull([]));

      await expect(syncNeonAllowlist()).rejects.toThrow();

      const upserts = mf(db.neonSyncStatus.upsert).mock.calls;
      const failure = upserts.at(-1)?.[0];
      expect(failure.update.lastError).toMatch(/zero active members/i);
    });
  });

  it("applies a big drop when the admin forces it", async () => {
    withPreviousCount(141);
    mf(listActiveNeonMembers).mockResolvedValue(pull([]));

    const result = await syncNeonAllowlist({ force: true });

    expect(result).toEqual({ activeCount: 0, removedCount: 141 });
    expect(tx.neonAllowlistMember.deleteMany).toHaveBeenCalledWith({});
  });

  it("still refuses a truncated pull even when forced (a short read is never real churn)", async () => {
    withPreviousCount(141);
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([member("a@example.com", "1")], { complete: false })
    );

    await expect(syncNeonAllowlist({ force: true })).rejects.toThrow(
      /incomplete/i
    );
    expect(tx.neonAllowlistMember.deleteMany).not.toHaveBeenCalled();
  });

  it("records a success, clearing any previous error", async () => {
    mf(listActiveNeonMembers).mockResolvedValue(
      pull([member("a@example.com", "1")])
    );

    await syncNeonAllowlist();

    const success = mf(db.neonSyncStatus.upsert).mock.calls.at(-1)?.[0];
    expect(success.update.lastError).toBeNull();
    expect(success.update.activeCount).toBe(1);
    expect(success.update.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("throws (and never calls Neon) when the API isn't configured", async () => {
    mf(isNeonApiConfigured).mockReturnValue(false);
    await expect(syncNeonAllowlist()).rejects.toThrow(/not set/i);
    expect(listActiveNeonMembers).not.toHaveBeenCalled();
  });
});
