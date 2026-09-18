/**
 * Asset title backup / restore (BIG workspace)
 *
 * Snapshots every asset's current title to JSON before a bulk rename, and can
 * put them all back. The rename is otherwise irreversible — there is no history
 * on `Asset.title`.
 *
 * Backup:  pnpm exec dotenv -e ../../.env -- tsx scripts/big-asset-title-backup.ts
 * Restore: pnpm exec dotenv -e ../../.env -- tsx scripts/big-asset-title-backup.ts --restore <file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const ORG_ID = "cmqr5o9ej0025iufy6v1j2304";

async function main() {
  const restoreIndex = process.argv.indexOf("--restore");

  if (restoreIndex !== -1) {
    const file = process.argv[restoreIndex + 1];
    const rows = JSON.parse(readFileSync(file, "utf8")) as {
      id: string;
      title: string;
    }[];
    for (const row of rows) {
      await db.asset.update({
        // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: maintenance script; the ids come from a backup file this same script wrote from findMany({ where: { organizationId: ORG_ID } }), so they are already scoped to the BIG workspace
        where: { id: row.id },
        data: { title: row.title },
      });
    }
    // eslint-disable-next-line no-console
    console.log(`Restored ${rows.length} asset titles from ${file}`);
    return;
  }

  const assets = await db.asset.findMany({
    where: { organizationId: ORG_ID },
    select: { id: true, title: true },
    orderBy: { id: "asc" },
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `/Users/stephen/BIG Shelf/asset-titles-backup-${stamp}.json`;
  writeFileSync(file, JSON.stringify(assets, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Backed up ${assets.length} asset titles to ${file}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
