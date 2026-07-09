/**
 * BIG Neon member allowlist — server service
 *
 * Neon CRM is BIG's source of truth for WHO is an active member. This module
 * owns the local mirror of that fact: the `NeonAllowlistMember` table. The admin
 * "Sync members from Neon" action pulls the current active-member list from the
 * Neon API and REPLACES the table (upsert the current set, delete anyone who has
 * dropped off). Nothing here creates a login: no Supabase users, no passwords,
 * no Shelf `User` rows. People still sign in by their own method (Google /
 * Microsoft / email OTP); the app only cross-references their email against this
 * table.
 *
 * Enforcement (the reserve gate and the signup cross-reference in
 * `~/modules/big-neon-auth`) reads THIS table via {@link isEmailOnNeonAllowlist}
 * / {@link findNeonAllowlistMemberByEmail} — a fast, offline-safe lookup — rather
 * than making a live Neon API call. The admin re-syncs to refresh membership.
 *
 * @see {@link file://./../../integrations/neon-crm/client.server.ts} — the Neon API client
 * @see {@link file://./../big-neon-auth/service.server.ts} — the enforcement that reads this table
 * @see {@link file://./../../routes/_layout+/settings.member-sync.tsx} — the admin UI
 */
import type { NeonAllowlistMember } from "@prisma/client";
import { db } from "~/database/db.server";
import {
  isNeonApiConfigured,
  listActiveNeonMembers,
} from "~/integrations/neon-crm/client.server";
import { ShelfError } from "~/utils/error";

const label = "Neon Sync" as const;

/** Outcome of a sync run — deliberately minimal. */
export type NeonAllowlistSyncResult = {
  /** How many active members are on the allowlist after this run. */
  activeCount: number;
};

/** Status of the allowlist, for the admin status line. */
export type NeonAllowlistStatus = {
  /** Rows currently on the allowlist. */
  activeCount: number;
  /** The most recent sync time (null when the allowlist has never been synced). */
  lastSyncedAt: Date | null;
};

/** Normalizes an email for storage/lookup: trimmed + lowercased, or null. */
function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/** Throws a 503 when the Neon REST API credentials are not configured. */
function assertNeonConfigured(): void {
  if (!isNeonApiConfigured()) {
    throw new ShelfError({
      cause: null,
      title: "Neon is not configured",
      message:
        "The Neon API credentials (NEON_ORG_ID + NEON_API_KEY) are not set for this site, so members can't be synced.",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }
}

/**
 * Refreshes the local active-member allowlist from Neon CRM.
 *
 * Pulls every ACTIVE member from Neon, then REPLACES the `NeonAllowlistMember`
 * table to match: each current member is upserted (by lowercased email) and any
 * row whose email is no longer active is removed. Runs in one transaction so the
 * table is never left half-updated. Creates NO login accounts of any kind.
 *
 * @returns The number of active members on the allowlist after the run
 * @throws {ShelfError} If the Neon API is not configured or a request fails
 */
export async function syncNeonAllowlist(): Promise<NeonAllowlistSyncResult> {
  assertNeonConfigured();

  const members = await listActiveNeonMembers();

  // Dedupe by lowercased email — the unique key — keeping the last seen record.
  // `listActiveNeonMembers` already dropped members with no email and deduped by
  // account id, but two accounts could share an email; the map collapses those.
  const byEmail = new Map<
    string,
    {
      email: string;
      firstName: string | null;
      lastName: string | null;
      neonAccountId: string;
    }
  >();
  for (const member of members) {
    const email = normalizeEmail(member.email);
    if (!email) {
      continue;
    }
    byEmail.set(email, {
      email,
      firstName: member.firstName,
      lastName: member.lastName,
      neonAccountId: member.neonAccountId,
    });
  }

  const syncedAt = new Date();
  const rows = [...byEmail.values()].map((row) => ({ ...row, syncedAt }));

  // Replace the whole table atomically: clear it, then bulk-insert the current
  // active set. Two statements (+ chunked inserts) instead of one round-trip per
  // member, so a large roster can't blow Prisma's default interactive-transaction
  // timeout (P2028) — which would roll the sync back and leave enforcement with
  // an empty allowlist. Concurrent readers see the pre-commit state (MVCC), so
  // there's never a window where the allowlist looks empty. `createdAt` is not
  // meaningful for a snapshot table, so delete+insert is fine.
  const CHUNK_SIZE = 500;
  await db.$transaction(
    async (tx) => {
      await tx.neonAllowlistMember.deleteMany({});
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        await tx.neonAllowlistMember.createMany({
          data: rows.slice(i, i + CHUNK_SIZE),
          skipDuplicates: true,
        });
      }
    },
    { timeout: 60_000 }
  );

  return { activeCount: rows.length };
}

/**
 * Reads the allowlist status for the admin UI. Cheap; never throws for an empty
 * or never-synced table (returns 0 / null).
 *
 * @returns The current row count and the most recent sync time
 */
export async function getNeonAllowlistStatus(): Promise<NeonAllowlistStatus> {
  const [activeCount, latest] = await Promise.all([
    db.neonAllowlistMember.count(),
    db.neonAllowlistMember.findFirst({
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
  ]);

  return { activeCount, lastSyncedAt: latest?.syncedAt ?? null };
}

/**
 * Looks up a member on the synced allowlist by email (case-insensitive).
 *
 * @param email - The email to look up
 * @returns The allowlist row, or `null` when the email isn't on the list
 */
export async function findNeonAllowlistMemberByEmail(
  email: string
): Promise<NeonAllowlistMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  return db.neonAllowlistMember.findUnique({ where: { email: normalized } });
}

/**
 * True when the email is on the synced active-member allowlist. The fast,
 * offline-safe check the reserve gate and signup cross-reference enforce against.
 *
 * @param email - The email to check
 * @returns Whether the email is currently on the allowlist
 */
export async function isEmailOnNeonAllowlist(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  const count = await db.neonAllowlistMember.count({
    where: { email: normalized },
  });
  return count > 0;
}
