/**
 * Asset rename plan — READ-ONLY unless `--apply`
 *
 * Proposes "Manufacturer Model" titles from the BIG workspace's `Manufacturer`
 * and `Model` custom fields, per the brief. Writes NOTHING without `--apply`.
 *
 * The naive version of this rule is dangerous on the real data, so the plan is
 * split into tiers by how confident it is:
 *
 *   TIER 1 — safe.  The current title carries no information ("Legacy Camera",
 *            "Untitled", "Unknown") and both Manufacturer and Model exist.
 *            Renaming is a pure gain. This is the case the brief called out.
 *
 *   TIER 2 — likely. Manufacturer and Model exist, the current title does NOT
 *            already contain the model, and the resulting name is UNIQUE among
 *            assets whose current titles differ. Safe in isolation but worth a
 *            human glance.
 *
 *   TIER 3 — review. Manufacturer and Model exist but the proposed name would
 *            collide with a differently-named asset, so applying it would merge
 *            two distinguishable things into one label (e.g. a ring light and
 *            its stand that share a model number).
 *
 *   TIER 4 — no Model. The brief says fall back to a common name. The category
 *            is NOT that common name: "AC Adapter, Editing Laptop" is more
 *            useful than "Asus Power Accessories". So the existing title is
 *            treated as the common name and the manufacturer is prefixed only
 *            when the title does not already start with it.
 *
 *   SKIP   — nothing better to say.
 *
 * Usage:
 *   plan:  pnpm exec dotenv -e ../../.env -- tsx scripts/big-asset-rename-plan.ts
 *   apply: pnpm exec dotenv -e ../../.env -- tsx scripts/big-asset-rename-plan.ts --apply --tiers=1,2
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** The BIG team workspace. */
const ORG_ID = "cmqr5o9ej0025iufy6v1j2304";

/** Values that mean "nothing was entered". */
const EMPTY_VALUES = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "unknown",
  "null",
  "undefined",
  "tbd",
  "?",
]);

/** Titles that carry no information about what the thing actually is. */
const PLACEHOLDER_TITLE =
  /^(legacy|unknown|untitled|no name|asset|item|misc|test)\b/i;

/** Reads a custom-field value into a trimmed string, or null when blank. */
function readValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).valueText ??
        (raw as Record<string, unknown>).raw
      : raw;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (EMPTY_VALUES.has(text.toLowerCase())) return null;
  return text;
}

/** Collapses repeated whitespace and trims. */
function tidy(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Loose containment test that ignores case, spaces and punctuation. */
function looselyContains(haystack: string, needle: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(haystack).includes(norm(needle));
}

/** Avoids "Sony Sony EX3" when the model already carries the maker's name. */
function joinName(manufacturer: string, model: string) {
  return looselyContains(model, manufacturer)
    ? tidy(model)
    : tidy(`${manufacturer} ${model}`);
}

type Tier = 1 | 2 | 3 | 4;

type Row = {
  id: string;
  tier: Tier;
  current: string;
  proposed: string;
  manufacturer: string | null;
  model: string | null;
  category: string | null;
  note: string;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const tierArg = process.argv.find((a) => a.startsWith("--tiers="));
  const applyTiers = new Set(
    (tierArg?.split("=")[1] ?? "1")
      .split(",")
      .map((t) => Number(t.trim()) as Tier)
  );

  const fields = await db.customField.findMany({
    where: {
      organizationId: ORG_ID,
      name: { in: ["Manufacturer", "Model"] },
      // A soft-deleted duplicate of either field would otherwise be a coin
      // flip in the `.find()` below, renaming assets from stale values.
      deletedAt: null,
    },
    select: { id: true, name: true },
  });
  const manufacturerFieldId = fields.find((f) => f.name === "Manufacturer")?.id;
  const modelFieldId = fields.find((f) => f.name === "Model")?.id;

  const assets = await db.asset.findMany({
    where: { organizationId: ORG_ID },
    select: {
      id: true,
      title: true,
      category: { select: { name: true } },
      customFields: { select: { value: true, customFieldId: true } },
    },
    orderBy: { title: "asc" },
  });

  // Pass 1: compute the "Manufacturer Model" candidate for everything, so pass
  // 2 can detect names that would collapse two different things into one.
  const candidates = assets.map((asset) => {
    const manufacturer = readValue(
      asset.customFields.find((f) => f.customFieldId === manufacturerFieldId)
        ?.value
    );
    const model = readValue(
      asset.customFields.find((f) => f.customFieldId === modelFieldId)?.value
    );
    return {
      asset,
      manufacturer,
      model,
      category: asset.category?.name ?? null,
      mfrModel: manufacturer && model ? joinName(manufacturer, model) : null,
    };
  });

  /** proposed name → the set of DISTINCT current titles that would take it. */
  const titlesPerName = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!c.mfrModel) continue;
    const set = titlesPerName.get(c.mfrModel) ?? new Set<string>();
    set.add(tidy(c.asset.title).toLowerCase());
    titlesPerName.set(c.mfrModel, set);
  }

  const rows: Row[] = [];
  const skipped: { id: string; title: string; why: string }[] = [];

  for (const c of candidates) {
    const current = tidy(c.asset.title);
    const isPlaceholder = PLACEHOLDER_TITLE.test(current);

    if (c.mfrModel) {
      // Would this name be shared by assets that are currently called
      // different things? If so it is merging distinguishable items.
      const collides = (titlesPerName.get(c.mfrModel)?.size ?? 0) > 1;

      if (c.mfrModel === current) {
        skipped.push({
          id: c.asset.id,
          title: current,
          why: "already correct",
        });
        continue;
      }

      if (isPlaceholder) {
        rows.push({
          id: c.asset.id,
          tier: 1,
          current,
          proposed: c.mfrModel,
          manufacturer: c.manufacturer,
          model: c.model,
          category: c.category,
          note: "Placeholder title replaced with Manufacturer + Model",
        });
        continue;
      }

      if (collides) {
        rows.push({
          id: c.asset.id,
          tier: 3,
          current,
          proposed: c.mfrModel,
          manufacturer: c.manufacturer,
          model: c.model,
          category: c.category,
          note: "Manufacturer + Model, but other differently-named assets share this model — review before applying",
        });
        continue;
      }

      if (looselyContains(current, c.model!)) {
        skipped.push({
          id: c.asset.id,
          title: current,
          why: "title already contains the model",
        });
        continue;
      }

      rows.push({
        id: c.asset.id,
        tier: 2,
        current,
        proposed: c.mfrModel,
        manufacturer: c.manufacturer,
        model: c.model,
        category: c.category,
        note: "Manufacturer + Model, unique",
      });
      continue;
    }

    // ---- No model ---------------------------------------------------------
    if (c.manufacturer) {
      if (isPlaceholder) {
        // Nothing but a maker and a category to go on.
        const common = c.category ?? "";
        const proposed = tidy(`${c.manufacturer} ${common}`);
        if (proposed && proposed !== current) {
          rows.push({
            id: c.asset.id,
            tier: 4,
            current,
            proposed,
            manufacturer: c.manufacturer,
            model: null,
            category: c.category,
            note: "Placeholder title, no Model — Manufacturer + category as the common name",
          });
          continue;
        }
      }

      if (!looselyContains(current, c.manufacturer)) {
        // The existing title IS the common name; just put the maker in front.
        rows.push({
          id: c.asset.id,
          tier: 4,
          current,
          proposed: tidy(`${c.manufacturer} ${current}`),
          manufacturer: c.manufacturer,
          model: null,
          category: c.category,
          note: "No Model — manufacturer prefixed to the existing common name",
        });
        continue;
      }

      skipped.push({
        id: c.asset.id,
        title: current,
        why: "no Model; title already names the manufacturer",
      });
      continue;
    }

    skipped.push({
      id: c.asset.id,
      title: current,
      why: "no Manufacturer recorded",
    });
  }

  const byTier = (tier: Tier) => rows.filter((r) => r.tier === tier);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        totals: {
          assets: assets.length,
          tier1_safe: byTier(1).length,
          tier2_likely: byTier(2).length,
          tier3_review: byTier(3).length,
          tier4_noModel: byTier(4).length,
          skipped: skipped.length,
        },
        tier1: byTier(1),
        tier2: byTier(2).slice(0, 25),
        tier3Sample: byTier(3).slice(0, 15),
        tier4Sample: byTier(4).slice(0, 15),
      },
      null,
      2
    )
  );

  // Full reviewable CSV next to the script.
  const csv = [
    "tier,assetId,currentTitle,proposedTitle,manufacturer,model,category,note",
    ...rows.map((r) =>
      [
        r.tier,
        r.id,
        r.current,
        r.proposed,
        r.manufacturer ?? "",
        r.model ?? "",
        r.category ?? "",
        r.note,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    ),
  ].join("\n");
  writeFileSync("/tmp/big-asset-rename-plan.csv", csv);
  // eslint-disable-next-line no-console
  console.log("\nCSV written to /tmp/big-asset-rename-plan.csv");

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log("DRY RUN — nothing written to the database.");
    return;
  }

  const toApply = rows.filter((r) => applyTiers.has(r.tier));
  for (const row of toApply) {
    await db.asset.update({
      // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: maintenance script; every id comes from the findMany({ where: { organizationId: ORG_ID } }) above, so it is already scoped to the BIG workspace
      where: { id: row.id },
      data: { title: row.proposed },
    });
  }
  // eslint-disable-next-line no-console
  console.log(
    `APPLIED tiers ${[...applyTiers].join(",")}: renamed ${
      toApply.length
    } assets.`
  );
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
