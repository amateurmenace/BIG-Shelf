/**
 * BIG Neon auth — client-safe constants
 *
 * Anything a ROUTE COMPONENT needs from the Neon-auth module lives here, never in
 * `service.server.ts`. That file reaches for Prisma, Supabase admin, and
 * `jsonwebtoken`; importing it from a component pulls all of that into the client
 * bundle and Vite rejects the build. Same split as `big-kiosk-content/shared.ts`.
 *
 * @see {@link file://./service.server.ts} — the server module, which re-exports this
 */

/**
 * The member-facing message shown wherever the active-Neon-membership check
 * fails — at signup, when a member tries to reserve without an active
 * membership, and in the member portal's "membership isn't active" banner.
 * Points them at renewal or a human.
 */
export const MEMBERSHIP_REQUIRED_MESSAGE =
  "We couldn't verify an active BIG membership for this account. If you think this is a mistake, email jessica@brooklineinteractive.org — or sign up for a BIG Membership at https://brooklineinteractive.app.neoncrm.com/forms/membership.";
