# BIG-Shelf — Fork Maintenance & Customization Guide

This repo is **Brookline Interactive Group's self-hosted fork** of
[shelf.nu](https://github.com/Shelf-nu/shelf.nu), used to run BIG's equipment
lending library. It is deployed on Fly.io as the `big-shelf` app.

This guide explains how to add our own features **without** making future
updates from upstream painful. Read it before you start customizing.

---

## Git topology

Two remotes, with different jobs:

| Remote     | Points at                           | You…                                          |
| ---------- | ----------------------------------- | --------------------------------------------- |
| `upstream` | `Shelf-nu/shelf.nu` (public)        | **pull FROM** — periodic updates. Never push. |
| `origin`   | `amateurmenace/BIG-Shelf` (private) | **push TO** — our backup + history.           |

```bash
git remote -v
# origin    https://github.com/amateurmenace/BIG-Shelf.git   (our fork)
# upstream  https://github.com/Shelf-nu/shelf.nu.git         (pull-only)
```

Branches:

- **`main`** — BIG's production line. This is what deploys to Fly.
- **`feat/<name>`** — one branch per feature you build. Merge into `main` when done.

---

## The golden rule: prefer _additive_ changes

Updates from upstream only hurt when they touch the **same lines** you did.
So keep our changes in **new files** wherever possible. New files never
conflict, because upstream isn't editing files it doesn't know about.

**Where BIG-specific code goes** (all namespaced so it can't collide):

| Kind               | Location                                           |
| ------------------ | -------------------------------------------------- |
| New page/route     | `apps/webapp/app/routes/_layout+/big.<name>.tsx`   |
| New business logic | `apps/webapp/app/modules/big-<name>/`              |
| New component      | `apps/webapp/app/components/big/<name>.tsx`        |
| New DB table       | additive migration via `pnpm db:prepare-migration` |

Editing an **existing** upstream file (like a shipped component or route) is
allowed but is the thing that creates merge conflicts forever. Do it
deliberately, keep the change small, and — if it's a genuine bug fix rather
than a BIG-specific tweak — consider contributing it back upstream so it stops
being our divergence.

The change tiers, cheapest/safest first:

1. **Config** — env flags + `apps/webapp/app/config/shelf.config.ts` (logo,
   favicon, `ENABLE_PREMIUM_FEATURES`, `DISABLE_SIGNUP`, …). No code divergence.
2. **Additive** — new routes/modules/components (above). Low risk. ← most features live here
3. **Schema** — additive Prisma migrations. Medium risk.
4. **Core edits** — changing existing files. Highest merge cost.

---

## Building a feature (Tier 1)

```bash
git checkout main
git pull origin main                       # sync with our backup
git checkout -b feat/equipment-report      # branch per feature

# …add NEW files under the big-namespaced paths above…

pnpm webapp:validate                       # tests + lint + typecheck
git add apps/webapp/app/…                  # stage your new files
git commit -m "feat(big): add equipment usage report"
git push -u origin feat/equipment-report   # backed up immediately

# when happy:
git checkout main
git merge feat/equipment-report
git push origin main                        # → triggers deploy (see below)
```

---

## Pulling updates from upstream Shelf.nu

Do this periodically to get upstream's bug fixes and features:

```bash
git checkout main
git fetch upstream
git merge upstream/main                     # resolve any conflicts here
pnpm webapp:validate                        # make sure nothing broke
git push origin main
```

If a conflict appears, it will be in a file **we edited** (a Tier-3 change).
That's the maintenance cost of core edits — another reason to prefer additive.

---

## Deployment

- **Manual (current):** `fly deploy` from the **repo root** uses the root
  [`fly.toml`](./fly.toml) (app `big-shelf`, region `ewr`). This deploys your
  **working tree**, including uncommitted changes — so commit first to keep git
  and production in sync.
  - ⚠️ The root `fly.toml` has **no `release_command`**, so a manual deploy
    does **not** run DB migrations. After pulling upstream changes that add a
    migration, run `pnpm db:deploy-migration` yourself — or add
    `release_command = "npx prisma migrate deploy"` to the root `fly.toml`.
- **CI (currently disabled):** GitHub Actions is **turned off** on this fork
  (as of 2026-07-06) so pushes don't spawn failing runs or risk an accidental
  deploy. [`deploy.yml`](.github/workflows/deploy.yml) would auto-deploy on push
  to `main`, but needs secrets in **our** repo (`FLY_API_TOKEN`,
  `SESSION_SECRET`, `SUPABASE_*`, `DATABASE_URL`). To enable CI later: add those
  secrets, then re-enable Actions (Settings → Actions → General).

> ⚠️ **Two `fly.toml` files exist — don't confuse them.** The root one is
> **BIG's** (manual deploy, `big-shelf` / `ewr`). `apps/webapp/fly.toml` is
> **upstream's** (`shelf-webapp` / `ams`, with a migration `release_command`)
> and is what `deploy.yml` reads — leave it untouched to avoid merge conflicts.
> If you enable CI later, point the workflow at the root `fly.toml` instead of
> editing upstream's file.

---

## Never commit secrets

`.env` lives at the monorepo root and is **gitignored** — keep it that way.
Real secrets live in Fly secrets (`fly secrets set …`) and Supabase, never in
this repo. Only `.env.example` is tracked.
