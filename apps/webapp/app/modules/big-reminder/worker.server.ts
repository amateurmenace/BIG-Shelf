/**
 * BIG reminder worker — self-rescheduling sweep
 *
 * `noScheduling: true` disables pg-boss's cron, but delayed one-off jobs
 * (`sendAfter`) and the worker still run. So this registers a worker that runs
 * {@link sweepReminders} and then re-enqueues the NEXT sweep a few hours out —
 * a durable "poor-man's cron" that survives restarts.
 *
 * Each enqueue is deduped by an hour-bucket `singletonKey`, so a redeploy (which
 * also kicks off a sweep) or two instances can never pile up more than one
 * pending sweep. Registered at boot from `app/entry.server.tsx`.
 *
 * @see {@link file://./service.server.ts}
 * @see {@link file://./../../utils/scheduler.server.ts}
 */
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { scheduler } from "~/utils/scheduler.server";
import { sweepReminders } from "./service.server";

const label = "Reminder" as const;

/** Dedicated pg-boss queue for the reminder sweep (auto-created on first use). */
const BIG_REMINDER_QUEUE = "big-reminder-queue";
/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Short delay for the boot-time kickoff sweep. */
const KICKOFF_DELAY_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Enqueues the next sweep. The `singletonKey` is bucketed by the target hour so
 * concurrent enqueues (self-reschedule + a restart's kickoff) collapse into one
 * pending job instead of multiplying the loop.
 *
 * @param delayMs - How far in the future to schedule the sweep
 */
async function enqueueNextSweep(delayMs: number): Promise<void> {
  const when = new Date(Date.now() + delayMs);
  const bucket = Math.floor(when.getTime() / HOUR_MS);
  await scheduler.sendAfter(
    BIG_REMINDER_QUEUE,
    {},
    { singletonKey: `big-reminder-sweep-${bucket}` },
    when
  );
}

/**
 * Registers the reminder-sweep worker and kicks off the first sweep. Call once
 * at server boot (after `scheduler.init()`).
 */
export async function registerBigReminderWorkers(): Promise<void> {
  await scheduler.work(BIG_REMINDER_QUEUE, async () => {
    try {
      const counts = await sweepReminders();
      Logger.info(
        `[big-reminder] sweep sent pickup=${counts.pickup} return=${counts.return} overdue=${counts.overdue}`
      );
    } catch (cause) {
      Logger.error(
        new ShelfError({ cause, message: "Reminder sweep failed", label })
      );
    } finally {
      // Always re-arm the loop, even if this sweep threw.
      await enqueueNextSweep(SWEEP_INTERVAL_MS).catch((cause) =>
        Logger.error(
          new ShelfError({
            cause,
            message: "Failed to re-arm reminder sweep",
            label,
          })
        )
      );
    }
  });

  // Kick off shortly after boot; deduped so restarts don't stack sweeps.
  await enqueueNextSweep(KICKOFF_DELAY_MS);
}
