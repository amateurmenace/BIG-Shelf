/**
 * Member directory — client-safe constants
 *
 * Route components import from HERE, never from `service.server.ts`: pulling a
 * `.server` module into the client bundle makes vite reject the build.
 *
 * @see {@link file://./service.server.ts}
 */

/**
 * Marks a picker option that is a Neon member with no Shelf record yet.
 *
 * The "Reserved for" picker offers two kinds of people: those who already have
 * a `TeamMember` row (staff, and members who have logged in at least once) and
 * those who exist only in the Neon allowlist. The second kind has no Shelf id
 * to reference, so the option carries `neon:<allowlistId>` and the server
 * materialises a real record at submit time.
 *
 * @see resolveReservationCustodian in ./service.server.ts
 */
export const NEON_CUSTODIAN_PREFIX = "neon:";

/** True when a custodian id refers to a Neon member with no Shelf record yet. */
export function isNeonCustodianId(id: string): boolean {
  return id.startsWith(NEON_CUSTODIAN_PREFIX);
}

/** Strips the prefix, yielding the `NeonAllowlistMember` id. */
export function neonAllowlistIdFromCustodianId(id: string): string {
  return id.slice(NEON_CUSTODIAN_PREFIX.length);
}
