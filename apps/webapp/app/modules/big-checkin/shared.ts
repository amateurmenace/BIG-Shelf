/**
 * Check-in wizard — client-safe constants and schemas
 *
 * Route components import from HERE, never from a `.server` module: pulling one
 * into the client bundle makes vite reject the build.
 *
 * @see {@link file://./../../routes/_layout+/check-in.tsx}
 */
import { AssetConditionGrade } from "@prisma/client";
import { z } from "zod";

/** Form intents handled by the check-in route's action. */
export const CHECKIN_INTENT = {
  /** Resolve one scanned code into an asset. */
  resolve: "resolveScan",
  /** Check the whole batch back in. */
  complete: "completeCheckin",
} as const;

/**
 * Condition grades offered in the wizard, worst first.
 *
 * Worst-first on purpose: someone only opens this panel because something is
 * wrong, so the option they need should be the first one their thumb reaches.
 */
export const CHECKIN_GRADES: {
  value: AssetConditionGrade;
  label: string;
  hint: string;
}[] = [
  {
    value: AssetConditionGrade.OUT_OF_SERVICE,
    label: "Out of service",
    hint: "Cannot go out again until it is fixed",
  },
  {
    value: AssetConditionGrade.POOR,
    label: "Damaged",
    hint: "Works, but something is broken or missing",
  },
  {
    value: AssetConditionGrade.FAIR,
    label: "Worn",
    hint: "Showing wear — worth keeping an eye on",
  },
  {
    value: AssetConditionGrade.GOOD,
    label: "Fine",
    hint: "Normal condition, just noting it",
  },
];

/** What the scanner posts to resolve a code. */
export const ResolveScanSchema = z.object({
  value: z.string().min(1),
  type: z.enum(["qr", "barcode", "samId"]),
});

/** What the "check these in" step posts. */
export const CompleteCheckinSchema = z.object({
  assetIds: z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Couldn't read the scanned items. Please scan them again.",
        });
        return z.NEVER;
      }
    })
    .pipe(z.array(z.string().min(1)).min(1, "Scan at least one item")),
});
