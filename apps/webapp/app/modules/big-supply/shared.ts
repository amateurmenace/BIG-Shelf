/**
 * Supplies — client-safe constants, labels and schemas
 *
 * Route components import from HERE, never from `service.server.ts`: pulling a
 * `.server` module into the client bundle makes vite reject the build.
 *
 * @see {@link file://./service.server.ts}
 */
import { SupplyCategory } from "@prisma/client";
import { z } from "zod";

/** Human labels for each supply category, in picker order. */
export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = {
  [SupplyCategory.CABLE]: "Cables",
  [SupplyCategory.BATTERY]: "Batteries",
  [SupplyCategory.POWER]: "Power",
  [SupplyCategory.AUDIO]: "Audio accessories",
  [SupplyCategory.LIGHTING]: "Lighting accessories",
  [SupplyCategory.MOUNTING]: "Mounts & rigging",
  [SupplyCategory.ADAPTER]: "Adapters",
  [SupplyCategory.MEDIA]: "Media & storage",
  [SupplyCategory.CONSUMABLE]: "Consumables",
  [SupplyCategory.OTHER]: "Other",
};

/** Category order used by the wizard's step list and the report's breakdown. */
export const SUPPLY_CATEGORY_ORDER: SupplyCategory[] = [
  SupplyCategory.CABLE,
  SupplyCategory.BATTERY,
  SupplyCategory.POWER,
  SupplyCategory.AUDIO,
  SupplyCategory.LIGHTING,
  SupplyCategory.MOUNTING,
  SupplyCategory.ADAPTER,
  SupplyCategory.MEDIA,
  SupplyCategory.CONSUMABLE,
  SupplyCategory.OTHER,
];

/** Upper bound on a single line's quantity — a guard against fat fingers. */
export const MAX_SUPPLY_QUANTITY = 999;

/** Create/update payload for a supply type. */
export const SupplyFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give the supply a name, e.g. “25ft XLR cable”"),
  description: z.string().trim().max(500).optional(),
  category: z.nativeEnum(SupplyCategory),
  quantityTotal: z.coerce
    .number()
    .int("Use a whole number")
    .min(0, "Cannot be negative")
    .max(100000, "That seems too many — check the number"),
  storageLocation: z.string().trim().max(120).optional(),
  isConsumable: z
    .union([z.literal("on"), z.literal("true"), z.literal("")])
    .optional()
    .transform((value) => value === "on" || value === "true"),
});

/**
 * The wizard's submission: a JSON array of `{ supplyId, quantity }`.
 *
 * A JSON blob rather than indexed form fields because the wizard builds the
 * basket client-side across several category steps; posting one field keeps the
 * server parse trivial and the client free to reorder.
 */
export const SupplyBasketSchema = z.object({
  supplyBasket: z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Could not read the supplies you selected. Please try again.",
        });
        return z.NEVER;
      }
    })
    .pipe(
      z.array(
        z.object({
          supplyId: z.string().min(1),
          quantity: z.coerce
            .number()
            .int()
            .min(0)
            .max(
              MAX_SUPPLY_QUANTITY,
              `Maximum ${MAX_SUPPLY_QUANTITY} per line`
            ),
        })
      )
    ),
});

/** Form intents handled by the booking page's supplies action. */
export const SUPPLY_INTENT = {
  saveBasket: "saveSupplyBasket",
} as const;

/** One line in the wizard basket. */
export type SupplyBasketLine = { supplyId: string; quantity: number };
