/**
 * BIG Neon allowlist sync — nightly self-rescheduling sweep
 *
 * Keeps the `NeonAllowlistMember` table (which the reserve gate and signup
 * cross-reference enforce against) fresh WITHOUT an admin ever clicking "Sync
 * members from Neon". `noScheduling: true` disables pg-boss's cron, but delayed
 * one-off jobs (`sendAfter`) and workers still run — so, exactly like the
 * reminder sweeper, this registers a worker that runs {@link syncNeonAllowlist}
 * and then re-enqueues the NEXT run for the following night. A durable
 * "poor-man's cron" that survives restarts.
 *
 * It also kicks off a sync shortly after each boot, so a fresh deploy (or the
 * very first one, when the allowlist is still empty) populates the allowlist
 * immediately instead of waiting for the nightly window. Every enqueue is
 * deduped by an hour-bucket `singletonKey`, so restarts/instances can't pile up
 * more than one pending sync. Registered at boot from `app/entry.server.tsx`.
 *
 * @see {@link file://./service.server.ts} — syncNeonAllowlist (idempotent replace)
 * @see {@link file://./../big-reminder/worker.server.ts} — the pattern mirrored here
 * @see {@link file://./../../utils/scheduler.server.ts}
 */
import { isNeonApiConfigured } from "~/integrations/neon-crm/client.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { scheduler } from "~/utils/scheduler.server";
import { syncNeonAllowlist } from "./service.server";

const label = "Neon Sync" as const;

/** Dedicated pg-boss queue for the nightly sync (auto-created on first use). */
const BIG_NEON_SYNC_QUEUE = "big-neon-sync-queue";
/**
 * Nightly target hour, in UTC. 8:00 UTC ≈ 3–4am US Eastern (BIG's timezone) —
 * off-peak, and well outside the Neon API's business-hours load.
 */
const TARGET_UTC_HOUR = 8;
/** Short delay for the boot-time kickoff sync (populates a fresh/empty allowlist). */
const KICKOFF_DELAY_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds from now until the next {@link TARGET_UTC_HOUR}:00 UTC. */
function msUntilNextTargetHour(): number {
  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(TARGET_UTC_HOUR, 0, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now;
}

/**
 * Enqueues a sync `delayMs` in the future. The `singletonKey` is bucketed by the
 * target hour so concurrent enqueues (the nightly re-arm + a redeploy's kickoff)
 * collapse into one pending job instead of multiplying the loop.
 *
 * @param delayMs - How far in the future to schedule the sync
 */
async function enqueueSync(delayMs: number): Promise<void> {
  const when = new Date(Date.now() + delayMs);
  const bucket = Math.floor(when.getTime() / HOUR_MS);
  await scheduler.sendAfter(
    BIG_NEON_SYNC_QUEUE,
    {},
    { singletonKey: `big-neon-sync-${bucket}` },
    when
  );
}

/**
 * Registers the nightly Neon-sync worker and kicks off the first sync. Call once
 * at server boot (after `scheduler.init()`).
 */
export async function registerBigNeonSyncWorkers(): Promise<void> {
  await scheduler.work(BIG_NEON_SYNC_QUEUE, async () => {
    try {
      // Skip cleanly (no error log) when Neon isn't configured — e.g. local dev
      // before creds are wired. Nothing to sync into the allowlist.
      if (!isNeonApiConfigured()) {
        Logger.info(
          "[big-neon-sync] nightly sync skipped — Neon API not configured"
        );
        return;
      }
      const { activeCount } = await syncNeonAllowlist();
      Logger.info(
        `[big-neon-sync] nightly sync refreshed the allowlist: ${activeCount} active members`
      );
    } catch (cause) {
      Logger.error(
        new ShelfError({
          cause,
          message: "Nightly Neon allowlist sync failed",
          label,
        })
      );
    } finally {
      // Always re-arm for the next nightly window, even if this run threw.
      await enqueueSync(msUntilNextTargetHour()).catch((cause) =>
        Logger.error(
          new ShelfError({
            cause,
            message: "Failed to re-arm the nightly Neon sync",
            label,
          })
        )
      );
    }
  });

  // Kick off shortly after boot; deduped so restarts don't stack syncs.
  await enqueueSync(KICKOFF_DELAY_MS);
}
