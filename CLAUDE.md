# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## BIG Fork — Local Customizations

> This repo is **Brookline Interactive Group's self-hosted fork** of shelf.nu.
> `origin` is our private repo; `upstream` is `Shelf-nu/shelf.nu` (pull-only).
> See **[`BIG-FORK.md`](./BIG-FORK.md)** in the repo root for the fork workflow:
> remotes, the safe-customization tiers, deployment, and pulling upstream.

Several features are **BIG-only** — they do **not** exist in upstream shelf.nu,
so expect merge conflicts in the **core-edit touch points** below when pulling
upstream. Each is built additively where possible; reconcile by keeping BIG's
additions on top of upstream's changes.

- **Rooms** — a reservable entity with a color that holds equipment (assets) and
  can be reserved in bookings (which also pulls in its gear). Additive:
  `app/modules/room/`, `app/components/rooms/`, `app/routes/_layout+/rooms.*`.
  Core edits: the booking service/overview, the schema (`Asset.roomId`,
  `Booking.rooms`), the permission matrix (`room` entity), the sidebar nav.
- **Member role** — a new `OrganizationRoles` value mirroring `SELF_SERVICE`,
  wired through the permission matrix, the invite/change-role UIs, and SSO
  mapping.
- **Member self-service portal** (`/reserve`) — the MEMBER landing surface, a
  small multi-page app: a **home dashboard** (`reserve._index` — greeting, big
  "Reserve equipment" / "Book a room" actions, upcoming reservations, plus the
  kiosk's shared content restyled for the light app theme: the rotating news
  banner, class/event promos as tappable links (not QR), an interactive 7-day
  day-picker + per-room hour timelines whose free slots deep-link to
  `reserve.rooms.$roomId?start=…` prefilled, and an embedded month/week
  FullCalendar with closed days shaded — all **anonymized**: members see when
  rooms are taken, never who), an equipment catalog + waitlist
  (`reserve.equipment`), and the room-booking flow (`reserve.rooms._index`
  picker + `reserve.rooms.$roomId` form, which validates/clamps the `?start=`
  deep-link param server-side). Additive: `app/modules/big-member/`,
  `app/routes/_layout+/reserve*.tsx`, `app/components/big/reserve/`. Core
  edits: the `home.tsx` MEMBER→`/reserve` redirect and the sidebar nav hook
  (members get a focused Home / Reserve equipment / Book a room / My
  reservations nav).
- **Member scan-to-reserve + equipment info pages + PWA** — the mobile-first
  "walk the shelves" flow: `/reserve/scan` is a CONTINUOUS multi-scan board
  (reuses the shared `CodeScanner`; QR / barcode / SAM-ID resolved org-scoped
  by `resolveScannedCode` — foreign labels are never resolvable): each scan
  drops the item straight into the order with a feedback flash + haptic + a
  running session list under the camera; the camera never pauses. Scans are
  QUEUED client-side via an `inFlight` ref — several detections can fire in
  one tick, and reading `fetcher.state` from the render closure would let a
  new `fetcher.submit` CANCEL the in-flight one (drops scans); a same-code
  cooldown stops one label from machine-gunning entries. Item details live on
  `/reserve/equipment/:assetId` (anonymized info page: large photo,
  availability, description, and admin-managed **guides** — manual/doc links
  plus YouTube/Vimeo video explainers embedded via the allowlist-only
  `videoEmbedUrl`; everything else renders as a plain link, never an iframe).
  Checkout at `/reserve/order` re-validates every id server-side and composes
  upstream `createBooking`→`reserveBooking` via `createEquipmentReservation`
  (Neon gate, conflicts, emails, loan agreement all fire). NOTE: the
  checkout's hidden cart field is `orderAssetIds` — the shared
  `BookingFormSchema` owns the `assetIds` name (array) and a JSON string
  under that name fails its validation. Guides are staff-managed on the
  asset page's **Guides** tab (`assets.$assetId.guides.tsx`, additive
  `AssetGuide` table). PWA: `static/manifest.json` + generated `app-icon-*`
  images + `/reserve/app` add-to-home-screen instructions. **Staff scanner
  quick actions** (`/scanner` ActionSwitcher): "Check out equipment" /
  "Check in equipment" (drawers post to additive `api+/big-desk.ts`, which
  groups scanned assets by their RESERVED/ONGOING booking and runs upstream
  `partialCheckoutBooking`/`partialCheckinBooking` per booking, returning
  per-asset failures; kits + kit-member assets are blocked) and "Make a
  reservation" (opens `/bookings/new?assetId=…` with scanned assets
  pre-selected). Additive: `app/modules/big-equipment/` (`service.server.ts`
  - client-safe `shared.ts`), `app/atoms/big-equipment-order.ts`,
    `app/components/big/reserve/{add-to-order-button,order-bar}.tsx`,
    `app/components/scanner/drawer/uses/big-*.tsx`, the
    `reserve.scan/equipment_.$assetId/order/app` + `api+/big-desk` routes.
    Core edits: the asset page tab list + a MEMBER→info-page redirect in
    `assets.$assetId.tsx` (members otherwise see the staff page with
    custody/location), catalog card CTAs, the dashboard action grid,
    `root.tsx` apple-touch-icon, the scanner's `ACTION_CONFIGS`/bulk branch,
    `use-nprogress.ts` (`big-scan-resolve` exclusion).
- **Room booking flow + week-ahead digest + kiosk wallboard** — a dedicated
  "book a room" pipeline (`app/modules/big-room-booking/`) that composes
  upstream `createBooking` → `updateBookingRooms` → `reserveBooking` (so the
  Neon gate, conflict validation, emails, and the Google Calendar mirror all
  fire) and adds **hard server-side room double-booking rejection** (upstream
  only greys conflicts out in the manage-rooms picker). Surfaces: member form
  (`reserve.rooms.$roomId`), staff form with custodian picker
  (`rooms.$roomId_.book`), live "Free until 3:00 PM" chips + Book buttons on
  the rooms index/detail, a printable staff digest (`/week-ahead`, gated
  `dashboard:read`), and a full-screen anonymized 16:9 touch wallboard
  (`app/routes/kiosk.tsx`, outside `_layout+`) with tap-a-slot walk-up booking
  (membership email → custodian; kiosk device must be signed in as staff).
  Shared UI in `app/components/big/room-booking/`. Core edits: rooms
  index/detail rows, the bookings-index header button, the sidebar nav hook.
  The wall also shows **admin-managed content** via the Settings → Kiosk CMS
  (`settings.kiosk.tsx`, gated `generalSettings`, TEAM-only): up to three
  class/event promo cards (uploaded image + sign-up QR; `KioskPromo` table),
  a welcoming "become a member" card (copy + QR target; `KioskConfig` table —
  hidden until a sign-up URL is set), a rotating **news banner** (admin-authored
  lines in `KioskConfig.newsMessages`, newline-separated), and a rolling 30-day
  closed-days calendar derived from the org's Working Hours (weekly schedule +
  overrides — one source of truth with booking validation). CMS forms save
  independently via a patch-based `upsertKioskConfig`; client-needed
  constants/schemas live in `big-kiosk-content/shared.ts`. Layout: the kiosk is
  a four-quadrant no-scroll board — room-schedule timeline (top-left) over the
  book-equipment / become-member / equipment-out cards (bottom-left), and the
  tappable "Next 7 days" day-picker (top-right, drives which day the timeline
  shows so people can book ahead) over the closed-days calendar (bottom-right);
  news banner + promo strip across the top; BIG Shelf logo on a white chip in
  the masthead. Additive: `app/modules/big-kiosk-content/`
  (`service.server.ts` + client-safe `shared.ts` — route components must
  import constants/schemas from `shared`, never from the `.server` file, or
  vite rejects the client bundle). Core edit: the settings tab list.
- **Neon CRM integration + multi-path auth** — Neon CRM is the source of truth
  for WHO is an active member, mirrored into a local allowlist table
  (`NeonAllowlistMember`) by the admin "Sync members from Neon" action. The sync
  creates NO login accounts/passwords; people sign in by their own method
  (Google / Microsoft / email OTP / Neon OAuth) and are cross-referenced against
  the allowlist at signup and at reserve time (plus the per-member
  `membershipCheckExempt` bypass). Additive: `app/integrations/neon-crm/`,
  `app/modules/big-neon-auth/`, `app/modules/big-neon-sync/`,
  `app/routes/_auth+/neon-*`, `app/routes/_layout+/settings.member-sync.tsx`.
  Core edits: `login.tsx`, `join.tsx`, `send-otp.tsx`, `otp.tsx`,
  `server/index.ts` (public-route allowlist), the user service,
  `utils/env.ts` (the `NEON_*` vars).
- **Digital loan agreements** — a per-checkout e-signed agreement putting
  liability on the borrower. Additive: `app/modules/big-loan-agreement/`,
  `app/routes/_layout+/loan-agreement.$bookingId.tsx`. Core edit: the checkout
  gate in `app/modules/booking/service.server.ts`.
- **Asset condition & maintenance tracking** — a dated, photo-supported condition
  log per asset. Additive: `app/modules/big-asset-condition/`,
  `app/routes/_layout+/assets.$assetId.condition.tsx`. Core edit: the tab
  registration in `assets.$assetId.tsx`.
- **Social login (Google / Microsoft) + redesigned auth pages** — Supabase OAuth
  "Continue with Google/Microsoft" that both signs in AND signs up (existing users
  log in; a new social identity is provisioned a Shelf user + personal workspace;
  an email already tied to another account is rejected). The login + join pages
  were redesigned social-first (brand-logo buttons primary, email/password
  minimized under an "or with email" divider, "Sign up"/"Log in" as prominent
  buttons); invitees also set their own password on the accept-invite page.
  Additive: `app/modules/big-social-auth/`,
  `app/components/big/social-login-buttons.tsx`, `app/routes/_auth+/oauth.social.*`.
  Core edits: `login.tsx`, `join.tsx`, `_auth.tsx` (layout + hero image at
  `public/static/images/big/login-hero.jpg`), `accept-invite.$inviteId.tsx`,
  `server/index.ts` (allowlist), `utils/env.ts`. Gated by
  `ENABLE_GOOGLE_LOGIN` / `ENABLE_MICROSOFT_LOGIN` (off until set) AND the provider
  must be enabled in the Supabase dashboard.
- **Room calendar → Google Workspace** — room bookings are mirrored in real time
  onto a shared Google Calendar (service-account push; one event per
  booking+room with a deterministic id, so pushes are idempotent). Booking
  lifecycle hooks (reserve / date change / rooms added-removed / extend /
  cancel / revert / delete / bulk cancel-delete) fire best-effort pushes that
  never break the mutation; an admin "Sync calendar now" reconciles (push all
  active + prune stale upcoming). Additive: `app/integrations/google-calendar/`,
  `app/modules/big-room-calendar/`,
  `app/routes/_layout+/settings.room-calendar.tsx`. Core edits: the lifecycle
  hooks in `app/modules/booking/service.server.ts`, the settings tab, and
  `utils/env.ts` (`GOOGLE_CALENDAR_SA_EMAIL`, `GOOGLE_CALENDAR_SA_PRIVATE_KEY`,
  `GOOGLE_ROOM_CALENDAR_ID` — feature is off until all three are set).

When adding new BIG features, prefer **additive** files (new modules / routes /
components) over editing upstream files, to keep upstream merges clean.

**Every new additive DB table must enable Row-Level Security in its migration.**
shelf enables RLS on public tables _outside_ migrations, so Prisma-created tables
ship without it and trip Supabase's `rls_disabled_in_public` critical alert (the
anon Data API can read/write them). The app reads via Prisma as the table owner
(bypassing RLS), so `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;` with no policies
is deny-all for anon and leaves the app unaffected. See the
`*_enable_rls_on_additive_tables` migration for the pattern.

## Essential Commands

This is a **pnpm + Turborepo monorepo**. Use `pnpm` instead of `npm`.

Root-level convenience scripts follow the `<app>:<task>` pattern (e.g., `webapp:dev`, `docs:build`). When adding new apps that require dev servers or build steps, add matching `<app>:<task>` shortcuts to the root `package.json`.

### Webapp

- `pnpm webapp:dev` - Start webapp dev server on port 3000
- `pnpm webapp:build` - Build webapp for production
- `pnpm webapp:test -- --run` - Run Vitest unit tests (always use `--run` flag)
- `pnpm webapp:validate` - Run all tests, linting, and typecheck (use before commits)
- `pnpm webapp:start` - Start webapp production server locally (loads `.env` from monorepo root)

**IMPORTANT:** When running tests manually, ALWAYS use the `--run` flag to run tests once and exit. Without `--run`, Vitest runs in watch mode which consumes excessive memory. Never run multiple test processes in parallel as this can freeze the system.

### Companion App (Mobile)

- `pnpm companion:dev` - Start Metro dev server (connects to existing build)
- `pnpm companion:dev:clear` - Start Metro with cleared cache (after env changes)
- `pnpm companion:build:ios` - Build native iOS + run on Simulator
- `pnpm companion:build:ios:device` - Build native iOS + run on physical iPhone
- `pnpm companion:build:android` - Build native Android + run on device/emulator
- `pnpm companion:prebuild:clean` - Regenerate iOS native project from Expo config
- `pnpm companion:doctor` - Run [react-doctor](https://www.react.doctor/) against the companion app (React Native diagnostics: deprecated modules, reanimated, FlatList perf, hook misuse)

See `apps/companion/README.md` for full setup guide (LAN IPs, HTTP mode, device trust).

### Docs

- `pnpm docs:dev` - Start docs dev server on port 5173
- `pnpm docs:build` - Build docs for production
- `pnpm docs:preview` - Preview docs production build on port 5174

### Code Quality

- `pnpm webapp:lint` - ESLint checking (webapp only)
- `pnpm turbo lint` - ESLint checking (all packages)
- `pnpm --filter @shelf/webapp lint:fix` - Fix ESLint issues automatically
- `pnpm turbo typecheck` - TypeScript type checking (all packages)
- `pnpm run format` - Prettier code formatting (root-level)
- `pnpm --filter @shelf/webapp validate` - Complete pre-commit validation
- `pnpm webapp:doctor` - Run [react-doctor](https://www.react.doctor/) against the webapp (React health diagnostics: hook misuse, perf, a11y, architecture). Not part of `validate` or the pre-commit hook. It **does** run in CI: the `🩺 React Doctor` GitHub Action scans changed files on every PR (matrix over webapp + companion), posts a per-app sticky comment, and fails the check on newly-introduced errors (warnings stay advisory). See [companion:doctor](#companion-app-mobile) for the React Native equivalent.

### Security Review Agent (pre-commit)

A Claude-powered security reviewer runs automatically on `git commit` against security-sensitive diffs (routes, `*.server.ts`, prisma, Supabase wiring, server middleware, new dependencies). It catches the regressions hit most often — cross-org IDORs, missing `requirePermission` gates, open redirects, missing Zod validation, audit-trail gaps — before code reaches review.

- Interactive subagent: `.claude/agents/shelf-security-reviewer.md` (full toolset — for manual `claude --agent shelf-security-reviewer ...` use with permission prompts).
- Headless subagent: `.claude/agents/shelf-security-reviewer-headless.md` (`Skill`-only — what the pre-commit hook invokes; safe under `bypassPermissions` because there's no Bash/network channel to exfiltrate through).
- Pre-commit wrapper: `scripts/security-review-staged.sh`
- Wired into `lefthook.yml` at priority 5 (after typecheck)

Advisory by default — findings print, the commit proceeds. Opt in to blocking with `SHELF_SEC_REVIEW_BLOCK=1`; skip with `SHELF_SEC_REVIEW=0`. Manual use: `claude --agent shelf-security-reviewer "review PR #N"`.

📖 Full documentation: [apps/docs/security-review-agent.md](./apps/docs/security-review-agent.md).

### Database

All database commands run via the `@shelf/database` package (`packages/database/`). This package owns the Prisma schema, migrations, and client generation. The webapp does **not** manage database concerns directly — it consumes `@shelf/database` as a workspace dependency.

- `pnpm db:generate` - Generate Prisma client after schema changes
- `pnpm db:prepare-migration` - Create new database migration
- `pnpm db:deploy-migration` - Apply migrations and regenerate client
- `pnpm db:reset` - Reset database (destructive!)
- `pnpm webapp:setup` - Generate Prisma client + deploy migrations (for initial setup/onboarding)

### Build & Production

- `pnpm turbo build` - Build all packages and apps for **production**
- `pnpm webapp:start` - Start production server locally (loads `.env` from monorepo root)
- `pnpm run start` (inside `apps/webapp/`) - Used by Docker/Fly (env vars from platform)

## Monorepo Structure

This is a **pnpm workspaces + Turborepo** monorepo. All packages are defined in `pnpm-workspace.yaml` and orchestrated by `turbo.json`.

### Apps

| Package            | Path              | Description                                                                                                           |
| ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@shelf/webapp`    | `apps/webapp/`    | Remix web application — the main product. Contains routes, components, modules (business logic), and integrations.    |
| `@shelf/companion` | `apps/companion/` | Expo/React Native mobile companion app. QR/barcode scanning, asset management, audits, bookings. Uses webapp API.     |
| `@shelf/docs`      | `apps/docs/`      | Developer documentation site (VitePress). Contains guides on local development, database triggers, architecture, etc. |

### Packages

| Package           | Path                 | Description                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shelf/database` | `packages/database/` | **Owns all database concerns**: Prisma schema (`prisma/schema.prisma`), migrations (`prisma/migrations/`), and the `createDatabaseClient()` factory (`src/client.ts`). All `db:*` root scripts delegate to this package. The webapp imports from this package — it does **not** run Prisma commands directly in production. |

### Tooling

| Package                    | Path                  | Description                                                           |
| -------------------------- | --------------------- | --------------------------------------------------------------------- |
| `@shelf/typescript-config` | `tooling/typescript/` | Shared `tsconfig` base configurations extended by all other packages. |

### How packages connect

- **Webapp → Database**: The webapp depends on `@shelf/database` (workspace dependency). Its `app/database/db.server.ts` is a thin wrapper that calls `createDatabaseClient()` from `@shelf/database`. All 135+ `~/database/db.server` imports in the webapp work unchanged.
- **Webapp → Prisma types**: The webapp's `build`, `typecheck`, and `validate` scripts run `prisma generate` to ensure types are available. In CI, this is done via `pnpm --filter @shelf/database run db:generate`.
- **Vite config**: The webapp's `vite.config.ts` includes `ssr.noExternal: ["@shelf/database"]` so Vite bundles it correctly, and aliases `.prisma/client/index-browser` for browser builds.

## Architecture Overview

**Shelf.nu** is an asset management platform built with Remix, React, TypeScript, and PostgreSQL.

### Core Technologies

- **Remix** - Full-stack React framework with file-based routing
- **Prisma** - Database ORM with PostgreSQL
- **Supabase** - Authentication, storage, and database hosting
- **Tailwind CSS + Radix UI** - Styling and UI components
- **Jotai** - Atomic state management

### Key Directory Structure

```
shelf/
├── turbo.json                       # Turborepo pipeline config
├── pnpm-workspace.yaml              # Workspace package definitions
├── packages/
│   └── database/                    # @shelf/database — Prisma client + types
│       ├── prisma/schema.prisma
│       ├── prisma/migrations/
│       └── src/client.ts            # createDatabaseClient() factory
├── apps/
│   └── webapp/                      # @shelf/webapp — Remix app
│       ├── app/
│       │   ├── routes/              # File-based routes (remix-flat-routes)
│       │   ├── modules/             # Business logic services
│       │   ├── components/          # Reusable React components
│       │   ├── database/db.server.ts # Thin re-export from @shelf/database
│       │   ├── atoms/               # Jotai state atoms
│       │   ├── utils/               # Utility functions
│       │   └── integrations/        # Third-party service integrations
│       └── server/                  # Hono server entry + middleware
└── tooling/
    └── typescript/                  # Shared tsconfig bases
```

### Route Organization

- `_layout+/` - Main authenticated application routes
- `_auth+/` - Authentication and login routes
- `_welcome+/` - User onboarding flow
- `api+/` - API endpoints
- `qr+/` - QR code handling for assets

## Development Patterns

### State Management

- **Server State**: Remix loaders/actions for data fetching and mutations
- **Client State**: Jotai atoms for complex UI state
- **URL State**: Search params for filters, pagination, and bookmarks
- **Optimistic UI & nProgress**: When implementing optimistic UI with fetchers, add the fetcher key to the `excludeFetchers` array in `apps/webapp/app/hooks/use-nprogress.ts` so the global loading bar does not show for operations that already provide instant visual feedback.

### Data Layer

- **Prisma Schema**: Located in `packages/database/prisma/schema.prisma` (owned by `@shelf/database`)
- **Client Generation**: Always run via `@shelf/database` (`pnpm db:generate`), never from the webapp directly
- **DB Client**: `@shelf/database` exports `createDatabaseClient()` factory; the webapp's `app/database/db.server.ts` is a thin wrapper
- **Row Level Security (RLS)**: Implemented via Supabase policies
- **Full-text Search**: PostgreSQL search across assets and bookings

### Component Architecture

- **Modular Services**: Business logic separated into `apps/webapp/app/modules/`
- **Reusable Components**: Organized by feature/domain in `apps/webapp/app/components/`
- **Form Handling**: Remix Form with client-side validation
- **UI Primitives**: Radix UI components with Tailwind styling
- **Date Display**: Always use the `DateS` component (`apps/webapp/app/components/shared/date.tsx`) for displaying dates in the UI. Do not use raw `toLocaleDateString()` or other custom date formatting.

### Email Templates

All HTML emails must follow the design established in
`app/emails/stripe/audit-trial-welcome.tsx`:

- **React Email components**: `Html`, `Head`, `Container`, `Text`, `Button`, `Link`
- **LogoForEmail** at the top of every email
- **Shared styles** from `app/emails/styles.ts` (`styles.p`, `styles.h2`, `styles.button`, `styles.li`)
- **Personalized greeting** with user's first name: `Hey {firstName},`
- **CTA buttons** using `styles.button` (not bare links)
- **Info/warning boxes**: yellow background `#FFF8E1` + border `#FFE082` for important notices
- **Both HTML and plain text exports**: HTML via `render()`, plain text as template literal
- **Send wrapper function** with `try/catch` + `Logger.error` + `ShelfError`
- **Closing**: `The Shelf Team`

### Button Type Prop (Required)

Every `<Button>` that renders as a native `<button>` element **must** have an explicit `type` prop. This is enforced by the `local-rules/require-button-type` ESLint rule.

- Use `type="submit"` for buttons that submit a form
- Use `type="button"` for all other buttons (modals, toggles, actions, etc.)
- Buttons with `to=` (link buttons) or `as="a"`/`as="span"` do not need `type`

```typescript
// ❌ Bad - missing type
<Button onClick={handler}>Cancel</Button>

// ✅ Good
<Button type="button" onClick={handler}>Cancel</Button>
<Button type="submit" disabled={disabled}>Save</Button>
<Button to="/home">Home</Button>  // Link button, no type needed
```

**Why:** The HTML spec defaults `<button>` to `type="submit"`, which can cause accidental form submissions. Explicit types prevent this and make intent clear.

### Disabled State for Form Submissions

Always use the `useDisabled` hook from `~/hooks/use-disabled` to disable buttons during form submission. Do **not** use `useNavigation` directly to check `navigation.state`.

```typescript
import { useDisabled } from "~/hooks/use-disabled";

// Inside component:
const disabled = useDisabled();
// For fetcher forms, pass the fetcher:
const disabled = useDisabled(fetcher);

<Button type="submit" disabled={disabled}>
  {disabled ? "Saving..." : "Save"}
</Button>
```

### Deprecated Components

- **DropdownMenu** (`apps/webapp/app/components/shared/dropdown.tsx`): Do not use for new features. Instead, use `Popover` from `@radix-ui/react-popover` with custom select behavior. See `apps/webapp/app/components/assets/assets-index/advanced-filters/field-selector.tsx` for a good example implementation.

### Silencing react-doctor findings

`react-doctor` runs in CI on every PR for both the webapp (`pnpm webapp:doctor`)
and the companion app (`pnpm companion:doctor`): warnings are advisory, but
**newly-introduced errors fail the PR check**, so keep both clean. The guidance
below applies to both apps.

**Important:** `react-doctor` does **not** respect `// eslint-disable-next-line` comments. The only way to silence a finding is to refactor the code so the pattern no longer matches. Standard ESLint disable comments still work for `pnpm webapp:lint` — they just don't help with `pnpm webapp:doctor`.

**Refactor strategies for common findings:**

- **`react/no-danger` for static CSS injection** — use React's native `<style>{cssString}</style>` form (safe text child). See `apps/webapp/app/components/shared/mobile-dropdown-styles.tsx` for the reusable mobile-dropdown helper.
- **`jsx-a11y/no-autofocus`** — remove the `autoFocus` prop, then focus imperatively with `ref.current?.focus()` inside a `useEffect` when intentional modal/form focus is needed. This satisfies the rule and keeps the UX.
- **`react/no-danger` for scripts (e.g., `<script>` injecting `window.env`)** — if no refactor is possible, the finding will remain. Leave a short `// why:` comment above the call site so maintainers understand why it's there, and treat it as an accepted residual.

**When you must leave a finding in place** (e.g., SSR script injection, third-party API that only returns HTML), add a `// why:` comment above the code even though the finding will still appear in scans. The comment is for humans reviewing the diff later, not for the tool.

```tsx
// why: <explanation>
// react-doctor flags this but refactoring would regress <X>
<script ... />
```

### Form Validation Pattern (Required)

**IMPORTANT:** All forms MUST display server-side validation errors as a fallback. Client-side validation can fail or be bypassed, so server-side errors must always be shown to users.

**Why This Matters:**

- Client-side validation can be bypassed (disabled JS, modified requests)
- Zod schemas may behave differently on client vs server (e.g., date comparisons)
- Users must always see meaningful error messages, never generic "Something went wrong"

**Implementation Steps:**

1. **Import required utilities:**

```typescript
import { useActionData } from "react-router";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
```

2. **Get validation errors from action data:**

```typescript
// Inside your component
const actionData = useActionData<DataOrErrorResponse>();

/** This handles server side errors in case client side validation fails */
const validationErrors = getValidationErrors<typeof yourZodSchema>(
  actionData?.error
);
```

3. **Display server errors as fallback in each input:**

```typescript
<Input
  name={zo.fields.fieldName()}
  error={
    validationErrors?.fieldName?.message || zo.errors.fieldName()?.message
  }
  // ... other props
/>
```

**Complete Example:**

```typescript
// Schema definition
export const myFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email"),
  date: z.coerce.date().min(new Date(), "Date must be in the future"),
});

// Component
export default function MyForm() {
  const zo = useZorm("MyForm", myFormSchema);

  const actionData = useActionData<DataOrErrorResponse>();
  const validationErrors = getValidationErrors<typeof myFormSchema>(
    actionData?.error
  );

  return (
    <Form method="POST">
      <Input
        name={zo.fields.name()}
        error={validationErrors?.name?.message || zo.errors.name()?.message}
        label="Name"
      />
      <Input
        name={zo.fields.email()}
        error={validationErrors?.email?.message || zo.errors.email()?.message}
        label="Email"
      />
      <Input
        type="datetime-local"
        name={zo.fields.date()}
        error={validationErrors?.date?.message || zo.errors.date()?.message}
        label="Date"
      />
      <Button type="submit">Submit</Button>
    </Form>
  );
}
```

**Working Examples:**

- Reminder dialog: `apps/webapp/app/components/asset-reminder/set-or-edit-reminder-dialog.tsx`
- Booking form: `apps/webapp/app/components/booking/forms/edit-booking-form.tsx`

### Accessibility

All UI implementations must meet **WCAG 2.1 AA** as a minimum. This includes:

- Sufficient color contrast ratios (4.5:1 for normal text, 3:1 for large text)
- All interactive elements must be keyboard accessible
- Form inputs must have associated labels
- Use `aria-describedby` to link inputs to helper/error text
- Meaningful alt text for images and icons
- Focus indicators must be visible

### Code Documentation (Required)

All code must include inline documentation and JSDoc comments. This applies to every new file and every new export.

**File-level documentation:**

- Every file must start with a JSDoc block explaining its purpose, responsibilities, and how it fits into the broader system
- Include `@see` references to related files (routes, services, components) where helpful

**Function/component-level documentation:**

- Every exported function, component, and type must have a JSDoc comment
- Describe what it does, its parameters (`@param`), return values (`@returns`), and thrown errors (`@throws`)
- For React components, document the props

**Inline comments:**

- Add inline comments to explain non-obvious logic, business rules, or important distinctions
- Especially important: when a variable name could be confused (e.g., `userId` referring to different users in different contexts), add a clarifying comment
- Explain "why" rather than "what" — the code shows what, comments explain why

**Example:**

```typescript
/**
 * User Note Service
 *
 * Handles CRUD operations for admin notes on user profiles.
 * Notes are workspace-scoped: a note in Workspace A is invisible in Workspace B.
 *
 * @see {@link file://./../../routes/_layout+/settings.team.users.$userId.note.tsx}
 */

/** Arguments for creating a user note */
type CreateUserNoteArgs = { ... };

/**
 * Creates a new note on a user's profile within a specific workspace.
 *
 * @param args - The note content, target user, organization, and optional author
 * @returns The created UserNote record
 * @throws {ShelfError} If the database operation fails
 */
export async function createUserNote(args: CreateUserNoteArgs) { ... }
```

### Code Abstraction

- When you notice duplicated code patterns across multiple files or functions,
  abstract them into reusable helper functions
- Before implementing new functionality, check if similar logic already exists
  that can be extracted and reused
- Keep helper functions focused on a single responsibility
- Place shared helpers near the code that uses them, or in a shared utils file
  if used across multiple modules

### Key Business Features

- **Asset Management**: CRUD operations, QR code generation, image processing
- **Booking System**: Calendar integration, conflict detection, PDF generation
- **Multi-tenancy**: Organization-based data isolation
- **Authentication**: Supabase Auth with SSO support

### Bulk Operations & Select All Pattern

When implementing bulk operations that work across multiple pages of filtered data, follow the **ALL_SELECTED_KEY pattern**:

**The Pattern:**

1. **Component Layer** - Pass current search params when "select all" is active
2. **Route/API Layer** - Extract and forward `currentSearchParams`
3. **Service Layer** - Use `getAssetsWhereInput` helper to build where clause from params

**Key Implementation Points:**

- Use `isSelectingAllItems()` from `apps/webapp/app/utils/list.ts` to detect select all
- Always pass `currentSearchParams` alongside `assetIds` when ALL_SELECTED_KEY is present
- Use `getAssetsWhereInput({ organizationId, currentSearchParams })` to build Prisma where clause
- Set `takeAll: true` to remove pagination limits

**Working Examples:**

- Export assets: `apps/webapp/app/components/assets/assets-index/export-assets-button.tsx`
- Bulk delete: `apps/webapp/app/routes/_layout+/assets._index.tsx` (action)
- QR download: `apps/webapp/app/routes/api+/assets.get-assets-for-bulk-qr-download.ts`

**📖 Full Documentation:** See [docs/select-all-pattern.md](./apps/docs/select-all-pattern.md) for detailed implementation guide, code examples, and common pitfalls.

## Testing Approach

### Unit Tests (Vitest)

- Tests co-located with source files
- Happy DOM environment for React component testing
- Run with `pnpm webapp:test -- --run` or `pnpm --filter @shelf/webapp test:cov` for coverage

### Validation Pipeline

Always run `pnpm webapp:validate` before committing - this runs:

1. Prisma type generation
2. ESLint with auto-fix
3. Prettier formatting
4. TypeScript checking
5. Unit tests

### Writing & Organizing Tests

#### Test Philosophy

- Write behavior-driven tests focusing on observable outcomes rather than implementation details.
- Tests should describe what the system does, not how it does it.
- Avoid testing internal private methods or state; instead, test public interfaces and user-visible effects.

#### When to Mock

- Mock only external network calls, time-based functions, feature flags, or heavy dependencies that are impractical or slow to run in tests.
- Avoid mocking internal business logic or utility functions to keep tests realistic and maintainable.
- Prefer using real implementations where possible to catch integration issues early.

#### Mock Justification Rule

- Every mock must be accompanied by a `// why:` comment explaining the reason for mocking.
- This encourages thoughtful use of mocks and helps reviewers understand test design choices.

#### Organizing Mocks and Factories

- **Test files**: Co-located with source files (e.g., `apps/webapp/app/modules/user/service.server.test.ts`)
- **Shared mocks**: Place in `apps/webapp/test/mocks/` directory, organized by domain (remix.tsx, database.ts)
- **Factories**: Place in `apps/webapp/test/factories/` directory for generating test data
- **MSW handlers**: Keep in `apps/webapp/mocks/` directory for API mocking

Example directory structure:

```
apps/webapp/
├── app/
│   ├── modules/
│   │   └── user/
│   │       ├── service.server.ts
│   │       └── service.server.test.ts  # Co-located test
├── test/
│   ├── mocks/
│   │   ├── remix.tsx          # Remix hook mocks
│   │   └── database.ts        # Database/Prisma mocks
│   └── factories/
│       ├── user.ts            # User factory
│       ├── asset.ts           # Asset factory
│       └── index.ts           # Export all
└── mocks/                      # MSW API handlers
    ├── handlers.ts
    └── index.ts
```

#### Path Aliases (Configured)

Path aliases are configured in `vitest.config.ts` for easy imports:

```typescript
import { createUser } from "@factories"; // → apps/webapp/test/factories/index.ts
import { createRemixMocks } from "@mocks/remix"; // → apps/webapp/test/mocks/remix.tsx
```

#### Factories & Test Data

- Use factories to generate consistent and realistic test data.
- Factories should allow overrides for specific fields to tailor data for each test case.
- Avoid hardcoding data within tests; use factories to keep tests clean and maintainable.

Example factory usage:

```typescript
import { userFactory } from "@factories/userFactory";

const testUser = userFactory.build({ role: "admin" });
```

#### Pre-Commit Checklist

Before committing tests:

- Ensure tests are behavior-driven and do not rely heavily on implementation details.
- Confirm mocks have `// why:` comments explaining their necessity.
- Verify tests run quickly and reliably without flaky behavior.
- Check that test data is generated via factories or well-structured mocks.
- Review test readability and maintainability.

## Environment Configuration

The `.env` file lives at the **monorepo root** (not inside `apps/webapp/`). Copy `.env.example` to `.env` and fill in your values. Vite, Prisma, and all `db:*` commands load from this single root file.

### Required Environment Variables

- `DATABASE_URL` and `DIRECT_URL` - PostgreSQL connections
- `SUPABASE_URL` and `SUPABASE_ANON_PUBLIC` - Supabase configuration
- `SESSION_SECRET` - Session encryption key

### Feature Flags

- `ENABLE_PREMIUM_FEATURES` - Toggle subscription requirements
- `DISABLE_SIGNUP` - Control user registration
- `SEND_ONBOARDING_EMAIL` - Control onboarding emails

## Important Files to Understand

1. **`packages/database/prisma/schema.prisma`** - Complete database schema and relationships
2. **`apps/webapp/app/config/shelf.config.ts`** - Application configuration and constants
3. **`apps/webapp/app/modules/`** - Core business logic services (asset, booking, user, etc.)
4. **`apps/webapp/app/routes/_layout+/`** - Main authenticated application routes
5. **`apps/webapp/vite.config.ts`** - Build configuration with Remix and development settings
6. **`packages/database/src/client.ts`** - Database client factory (shared across apps)

## Development Workflow

1. **Database Changes**: Modify `packages/database/prisma/schema.prisma` → `pnpm db:prepare-migration` → `pnpm db:deploy-migration` (runs via `@shelf/database`)
2. **New Features**: Create in `apps/webapp/app/modules/` for business logic, `apps/webapp/app/routes/` for pages
3. **Component Updates**: Follow existing patterns in `apps/webapp/app/components/`
4. **Testing**: Write unit tests for utilities  
   Follow the testing conventions outlined in the Writing & Organizing Tests section to ensure consistent, behavior-driven testing and minimal mocking.
5. **Pre-commit**: Always run `pnpm webapp:validate` to ensure code quality

## Git and Version control

- **NEVER stage (`git add`) or commit files automatically.** Only stage or commit when the user explicitly asks you to do so.
- Always use Conventional Commits spec when making commits and opening PRs: https://www.conventionalcommits.org/en/v1.0.0/
- use descriptive commit messages that capture the full scope of the changes
- **IMPORTANT: Each line in the commit message body must be ≤ 100 characters**
  - Wrap long lines to stay within the limit
  - This is enforced by commitlint pre-commit hook
  - Subject line can be longer, only body lines are restricted
- dont add 🤖 Generated with [Claude Code](https://claude.ai code) & Co-Authored-By: Claude <noreply@anthropic.com>" because it clutters the commits
- Include test readability and mock discipline in PR reviews. Overly mocked or verbose tests should be refactored before merge.

## Rule Improvement Triggers

- New code patterns not covered by existing rules
- Repeated similar implementations across files
- Common error patterns that could be prevented
- New libraries or tools being used consistently
- Emerging best practices in the codebase

# Analysis Process:

- Compare new code with existing rules
- Identify patterns that should be standardized
- Look for references to external documentation
- Check for consistent error handling patterns
- Monitor test patterns and coverage

# Rule Updates:

- **Add New Rules When:**

  - A new technology/pattern is used in 3+ files
  - Common bugs could be prevented by a rule
  - Code reviews repeatedly mention the same feedback
  - New security or performance patterns emerge

- **Modify Existing Rules When:**

  - Better examples exist in the codebase
  - Additional edge cases are discovered
  - Related rules have been updated
  - Implementation details have changed

- **Example Pattern Recognition:**

  ```typescript
  // If you see repeated patterns like:
  const data = await prisma.user.findMany({
    select: { id: true, email: true },
    where: { status: "ACTIVE" },
  });

  // Consider adding to the files
  // - Standard select fields
  // - Common where conditions
  // - Performance optimization patterns
  ```

- **Rule Quality Checks:**
- Rules should be actionable and specific
- Examples should come from actual code
- References should be up to date
- Patterns should be consistently enforced

## Continuous Improvement:

- Monitor code review comments
- Track common development questions
- Update rules after major refactors
- Add links to relevant documentation
- Cross-reference related rules

## Rule Deprecation

- Mark outdated patterns as deprecated
- Remove rules that no longer apply
- Update references to deprecated rules
- Document migration paths for old patterns

## Documentation Updates:

- Keep examples synchronized with code
- Update references to external docs
- Maintain links between related rules
- Document breaking changes

- When you write any knowledgebase articles or documentation always provide the content in markdown
