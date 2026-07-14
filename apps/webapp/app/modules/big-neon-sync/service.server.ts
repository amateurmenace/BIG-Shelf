/**
 * BIG Neon member allowlist — server service
 *
 * Neon CRM is BIG's source of truth for WHO is an active member. This module
 * owns the local mirror of that fact: the `NeonAllowlistMember` table. The admin
 * "Sync members from Neon" action pulls the current active-member list from the
 * Neon API and REPLACES the table (insert the current set, drop anyone who has
 * fallen off). Nothing here creates a login: no Supabase users, no passwords, no
 * Shelf `User` rows. People still sign in by their own method (Google /
 * Microsoft / email OTP); the app only cross-references their email against this
 * table.
 *
 * Enforcement (the reserve gate and the signup cross-reference in
 * `~/modules/big-neon-auth`) reads THIS table — a fast, offline-safe lookup —
 * rather than making a live Neon API call on every check.
 *
 * ## Why this module is defensive
 *
 * In July 2026 Neon revoked BIG's API key. Every sync failed from then on, but a
 * failed sync left NO trace: the allowlist silently kept its stale rows, and the
 * reserve gate went on treating "not on the list" as "not a member". Members who
 * joined after the last good sync were told their membership was inactive, for
 * four days, with nobody alerted. Three defenses came out of that:
 *
 *  1. **Sync health is persisted** ({@link NeonSyncStatus}) — successes AND
 *     failures — so a broken sync is visible instead of silent.
 *  2. **The replace is guarded** ({@link assertSafeReplacement}) — a truncated or
 *     empty pull can never wipe the allowlist, because a dropped member is a
 *     locked-out member.
 *  3. **A stale allowlist stops being grounds for denial** — see
 *     {@link isAllowlistTrustworthy}, which the reserve gate consults before it
 *     turns "not on the list" into "you are not a member".
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
  resolveNeonMemberByEmail,
  type NeonActiveMemberList,
} from "~/integrations/neon-crm/client.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

const label = "Neon Sync" as const;

/** The `NeonSyncStatus` table holds exactly one row, under this id. */
const SYNC_STATUS_ID = "singleton";

/**
 * How old the last SUCCESSFUL sync may get before the allowlist stops being
 * trustworthy grounds for DENYING a member. The sync runs nightly, so three days
 * means at least two consecutive nightly failures — comfortably past a transient
 * blip, and well short of the four days it took to notice the last outage.
 */
export const ALLOWLIST_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * A sync may not shrink the allowlist below this fraction of its previous size
 * without `force`. Real membership churn is gradual; a sudden halving means the
 * pull was broken, and replacing the table with it would lock out everyone who
 * vanished.
 */
const MAX_SHRINK_RATIO = 0.5;

/** Rows per bulk insert — keeps a large roster inside the transaction timeout. */
const CHUNK_SIZE = 500;

/** Outcome of a sync run. */
export type NeonAllowlistSyncResult = {
  /** How many active members are on the allowlist after this run. */
  activeCount: number;
  /** How many rows the run removed (members who lapsed since the last sync). */
  removedCount: number;
};

/** Why the allowlist can't be trusted to justify denying a member. */
export type AllowlistDistrustReason = "never-synced" | "empty" | "stale";

/** Status of the allowlist + the sync that maintains it, for the admin UI. */
export type NeonAllowlistStatus = {
  /** Rows currently on the allowlist. */
  activeCount: number;
  /** The most recent SUCCESSFUL sync (null when never synced). */
  lastSyncedAt: Date | null;
  /** The most recent sync ATTEMPT, successful or not. */
  lastAttemptAt: Date | null;
  /** The failure message from the most recent run; null when it succeeded. */
  lastError: string | null;
  /**
   * Whether the allowlist is fresh enough that "not on the list" genuinely means
   * "not a member". When false, the reserve gate fails OPEN instead of denying.
   */
  trustworthy: boolean;
  /** Why it isn't trustworthy, when it isn't. */
  distrustReason: AllowlistDistrustReason | null;
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
 * Refuses a destructive replace that would clearly do more harm than good.
 *
 * The allowlist is rebuilt by deleting every row and re-inserting the pull, so
 * anything MISSING from the pull is silently un-membered and locked out of
 * reserving. A pull can come back short for reasons that have nothing to do with
 * membership — a truncated page walk, an unsorted page walk that skipped rows,
 * a Neon-side hiccup returning 200 with an empty body — and none of those are
 * grounds for revoking anyone's access.
 *
 * @param args.previousCount - Rows on the allowlist before this run
 * @param args.nextCount - Rows the pull would replace them with
 * @param args.pull - The client's completeness bookkeeping for the pull
 * @param args.force - Admin override for the shrink guards (a genuine mass lapse)
 * @throws {ShelfError} When the replacement looks like data loss rather than churn
 */
function assertSafeReplacement({
  previousCount,
  nextCount,
  pull,
  force,
}: {
  previousCount: number;
  nextCount: number;
  pull: NeonActiveMemberList;
  force: boolean;
}): void {
  // A short read is never legitimate, force or not — it means we did not see
  // Neon's whole answer, so we cannot know who is really missing.
  if (!pull.complete) {
    throw new ShelfError({
      cause: null,
      title: "Sync aborted — incomplete read",
      message:
        "Neon's member list was still paginating when the page cap was hit, so the pull is incomplete. The allowlist was left untouched rather than replaced with a partial list (which would lock out every member who didn't make it into the pull).",
      label,
      status: 500,
      shouldBeCaptured: true,
    });
  }

  if (pull.totalResults !== null && pull.rowsSeen < pull.totalResults) {
    throw new ShelfError({
      cause: null,
      title: "Sync aborted — rows went missing",
      message: `Neon reported ${pull.totalResults} matching members but only ${pull.rowsSeen} rows came back across all pages. The allowlist was left untouched rather than replaced with a lossy list.`,
      label,
      status: 500,
      shouldBeCaptured: true,
    });
  }

  if (force) {
    return;
  }

  // Never let a sync empty the allowlist. If Neon really has zero active
  // members, an admin can force it — but the overwhelmingly likelier causes are
  // a broken query or a bad credential, and both should keep members working.
  if (nextCount === 0 && previousCount > 0) {
    throw new ShelfError({
      cause: null,
      title: "Sync aborted — Neon returned no active members",
      message: `Neon returned zero active members, which would have removed all ${previousCount} people from the allowlist and blocked every member from reserving. The allowlist was left untouched. Check the membership search in Neon; re-run with "force" if the roster really is empty.`,
      label,
      status: 500,
      shouldBeCaptured: true,
    });
  }

  if (
    previousCount > 0 &&
    nextCount < Math.floor(previousCount * MAX_SHRINK_RATIO)
  ) {
    throw new ShelfError({
      cause: null,
      title: "Sync aborted — suspiciously large drop",
      message: `Neon returned ${nextCount} active members, down from ${previousCount} — more than half the allowlist would have been removed and those members blocked from reserving. The allowlist was left untouched. Re-run with "force" if this drop is real.`,
      label,
      status: 500,
      shouldBeCaptured: true,
    });
  }
}

/**
 * Records that a sync run has started. Best-effort: bookkeeping must never be
 * the reason a sync fails.
 */
async function recordSyncAttempt(): Promise<void> {
  const now = new Date();
  try {
    await db.neonSyncStatus.upsert({
      where: { id: SYNC_STATUS_ID },
      create: { id: SYNC_STATUS_ID, lastAttemptAt: now },
      update: { lastAttemptAt: now },
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({ cause, message: "Could not record sync attempt", label })
    );
  }
}

/**
 * Records a successful run and clears any previous error. Best-effort.
 *
 * @param activeCount - Rows written by the run
 */
async function recordSyncSuccess(activeCount: number): Promise<void> {
  const now = new Date();
  try {
    await db.neonSyncStatus.upsert({
      where: { id: SYNC_STATUS_ID },
      create: {
        id: SYNC_STATUS_ID,
        lastAttemptAt: now,
        lastSuccessAt: now,
        activeCount,
        lastError: null,
      },
      update: { lastSuccessAt: now, activeCount, lastError: null },
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({ cause, message: "Could not record sync success", label })
    );
  }
}

/**
 * Records a failed run so the admin UI can show WHY the allowlist is stale.
 * Best-effort — a bookkeeping failure must not mask the real error.
 *
 * @param cause - The error that ended the run
 */
async function recordSyncFailure(cause: unknown): Promise<void> {
  const message =
    cause instanceof Error
      ? cause.message
      : "The sync failed for unknown reasons";
  try {
    await db.neonSyncStatus.upsert({
      where: { id: SYNC_STATUS_ID },
      create: {
        id: SYNC_STATUS_ID,
        lastAttemptAt: new Date(),
        lastError: message.slice(0, 1000),
      },
      update: { lastError: message.slice(0, 1000) },
    });
  } catch (recordCause) {
    Logger.error(
      new ShelfError({
        cause: recordCause,
        message: "Could not record sync failure",
        label,
      })
    );
  }
}

/**
 * Refreshes the local active-member allowlist from Neon CRM.
 *
 * Pulls every ACTIVE member from Neon and REPLACES the `NeonAllowlistMember`
 * table to match — but only once {@link assertSafeReplacement} agrees the pull
 * is complete and the change looks like churn rather than data loss. Runs in one
 * transaction so the table is never left half-updated. Creates NO logins.
 *
 * Every run — success or failure — is recorded to `NeonSyncStatus`, so a broken
 * sync surfaces in the admin UI instead of silently freezing the allowlist.
 *
 * @param options.force - Bypass the empty/large-drop guards (a real mass lapse)
 * @returns How many members are on the allowlist, and how many the run removed
 * @throws {ShelfError} If Neon is not configured, a request fails, or the pull
 *   is unsafe to replace the allowlist with
 */
export async function syncNeonAllowlist(options?: {
  force?: boolean;
}): Promise<NeonAllowlistSyncResult> {
  assertNeonConfigured();
  await recordSyncAttempt();

  try {
    const pull = await listActiveNeonMembers();

    // Dedupe by lowercased email — the unique key — keeping the last seen record.
    // The client already dropped members with no email and deduped by account id;
    // this collapses two Neon accounts that share one email.
    const byEmail = new Map<
      string,
      {
        email: string;
        firstName: string | null;
        lastName: string | null;
        neonAccountId: string;
      }
    >();
    for (const member of pull.members) {
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

    const previousCount = await db.neonAllowlistMember.count();
    assertSafeReplacement({
      previousCount,
      nextCount: rows.length,
      pull,
      force: options?.force ?? false,
    });

    // Replace the whole table atomically: clear it, then bulk-insert the current
    // active set. Two statements (+ chunked inserts) instead of one round-trip per
    // member, so a large roster can't blow Prisma's default interactive-transaction
    // timeout (P2028) — which would roll the sync back and leave enforcement with
    // an empty allowlist. Concurrent readers see the pre-commit state (MVCC), so
    // there's never a window where the allowlist looks empty. `createdAt` is not
    // meaningful for a snapshot table, so delete+insert is fine.
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

    await recordSyncSuccess(rows.length);

    return {
      activeCount: rows.length,
      removedCount: Math.max(0, previousCount - rows.length),
    };
  } catch (cause) {
    // Persist WHY before rethrowing — this is the record that makes a broken
    // sync visible instead of silent.
    await recordSyncFailure(cause);
    throw cause;
  }
}

/**
 * Reads the allowlist + sync health for the admin UI. Cheap; never throws for an
 * empty or never-synced table.
 *
 * @returns Row count, last success/attempt, last error, and whether the list is
 *   fresh enough to be trusted as grounds for denying a member
 */
export async function getNeonAllowlistStatus(): Promise<NeonAllowlistStatus> {
  const [activeCount, status] = await Promise.all([
    db.neonAllowlistMember.count(),
    db.neonSyncStatus.findUnique({ where: { id: SYNC_STATUS_ID } }),
  ]);

  const lastSyncedAt = status?.lastSuccessAt ?? null;

  let distrustReason: AllowlistDistrustReason | null = null;
  if (!lastSyncedAt) {
    distrustReason = "never-synced";
  } else if (activeCount === 0) {
    distrustReason = "empty";
  } else if (Date.now() - lastSyncedAt.getTime() > ALLOWLIST_STALE_AFTER_MS) {
    distrustReason = "stale";
  }

  return {
    activeCount,
    lastSyncedAt,
    lastAttemptAt: status?.lastAttemptAt ?? null,
    lastError: status?.lastError ?? null,
    trustworthy: distrustReason === null,
    distrustReason,
  };
}

/**
 * Whether the allowlist is fresh enough that a MISS genuinely means "not a
 * member" — as opposed to "our copy of Neon is broken or out of date".
 *
 * The reserve gate calls this before it denies anyone. A never-synced, empty, or
 * stale allowlist means the integration is broken, and a broken integration must
 * not punish paying members: the gate fails OPEN instead.
 *
 * @returns True when a miss is a trustworthy denial
 */
export async function isAllowlistTrustworthy(): Promise<boolean> {
  const { trustworthy } = await getNeonAllowlistStatus();
  return trustworthy;
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
 * offline-safe check enforcement runs first.
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

/**
 * Asks Neon about ONE person, live, and folds the answer back into the allowlist.
 *
 * The allowlist is a nightly snapshot, so someone who joins or renews TODAY is
 * legitimately active but absent from it — and would be told their membership is
 * inactive until the next successful sync. Enforcement calls this on the deny
 * path, so a real member is admitted immediately, and the allowlist self-heals:
 * the row is written, and the next check is a pure local hit.
 *
 * Only ever ADDS. Removal stays the sync's job, so a Neon blip can't revoke
 * anyone.
 *
 * @param email - The email to verify against Neon
 * @returns The (upserted) allowlist row when Neon says they're active; `null`
 *   when Neon has no such account, or has one that isn't active
 * @throws {ShelfError} If the Neon API is unconfigured or the request fails —
 *   callers MUST treat that as "couldn't verify", never as "not a member"
 */
export async function refreshAllowlistMemberFromNeon(
  email: string
): Promise<NeonAllowlistMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  const live = await resolveNeonMemberByEmail(normalized);
  if (!live?.isActiveMember) {
    return null;
  }

  const row = {
    email: normalized,
    firstName: live.firstName,
    lastName: live.lastName,
    neonAccountId: live.neonAccountId,
    syncedAt: new Date(),
  };

  return db.neonAllowlistMember.upsert({
    where: { email: normalized },
    create: row,
    update: row,
  });
}
