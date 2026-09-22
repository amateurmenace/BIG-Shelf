/**
 * Member directory — client-safe types, id helpers and search
 *
 * Route components and the picker import from HERE, never from
 * `service.server.ts`: pulling a `.server` module into the client bundle makes
 * vite reject the build.
 *
 * @see {@link file://./service.server.ts} — builds the list and resolves picks
 * @see {@link file://./../../components/big/member-picker.tsx} — the picker
 */

/**
 * Marks a picker option that is a Neon member with no Shelf record yet.
 *
 * The "Reserved for" picker offers people who already have a `TeamMember` row
 * (staff, members who have logged in, earlier account-less bookings) and people
 * who exist only in the Neon directory. The second kind has no Shelf id, so the
 * option carries `neon:<email>` and the server creates a record on submit.
 *
 * Keyed by EMAIL, not by `NeonAllowlistMember.id`: the Neon sync deletes and
 * re-inserts every allowlist row, so those ids change on every run and a page
 * left open overnight would submit an id that no longer exists.
 *
 * @see resolveReservationCustodian in ./service.server.ts
 */
export const NEON_CUSTODIAN_PREFIX = "neon:";

/** True when a custodian id refers to a Neon member with no Shelf record yet. */
export function isNeonCustodianId(id: string): boolean {
  return id.startsWith(NEON_CUSTODIAN_PREFIX);
}

/** Builds the picker id for a directory-only member. */
export function neonCustodianIdForEmail(email: string): string {
  return `${NEON_CUSTODIAN_PREFIX}${email.trim().toLowerCase()}`;
}

/** Recovers the (lowercased) email from a directory-only picker id. */
export function emailFromNeonCustodianId(id: string): string {
  return id.slice(NEON_CUSTODIAN_PREFIX.length).trim().toLowerCase();
}

/** One person staff can reserve for, as the picker receives it. */
export type ReservablePerson = {
  /** A `TeamMember` id, or `neon:<email>` for a directory-only member. */
  id: string;
  name: string;
  /** Null only for records that have never had an email (e.g. "BIG"). */
  email: string | null;
  /** Their account, when they have one. */
  userId: string | null;
  /**
   * Whether they can sign in. Only account holders are emailed to confirm a
   * reservation made for them — the picker says so, so staff aren't surprised
   * when someone without an account gets no email.
   */
  hasAccount: boolean;
};

/** Lowercases and strips accents, so "jose" finds "José". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Filters people by a free-text query, entirely client-side.
 *
 * Every whitespace-separated word must appear somewhere in the person's name
 * or email, in any order — so "jansen bea", "bea j" and "example bea" all find
 * "bea JANSEN <bea.jansen@example.com>". An empty query returns everyone.
 *
 * @param people - The full list, as loaded from the directory endpoint.
 * @param query - What the user typed.
 * @returns The matching people, in their original order.
 */
export function filterReservablePeople(
  people: ReservablePerson[],
  query: string
): ReservablePerson[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return people;

  return people.filter((person) => {
    const haystack = normalize(`${person.name} ${person.email ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
}
