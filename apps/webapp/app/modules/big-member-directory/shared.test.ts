import { describe, expect, it } from "vitest";
import type { ReservablePerson } from "./shared";
import {
  emailFromNeonCustodianId,
  filterReservablePeople,
  isNeonCustodianId,
  neonCustodianIdForEmail,
} from "./shared";

/** Builds a person; tests override only what they are about. */
function person(overrides: Partial<ReservablePerson>): ReservablePerson {
  return {
    id: "tm-1",
    name: "Someone",
    email: null,
    userId: null,
    hasAccount: false,
    ...overrides,
  };
}

const PEOPLE: ReservablePerson[] = [
  person({ id: "tm-staff", name: "Dee Admin", email: "dee@example.org" }),
  person({
    id: "neon:bea.jansen@example.com",
    name: "bea JANSEN",
    email: "bea.jansen@example.com",
  }),
  person({
    id: "neon:jose@example.com",
    name: "José Álvarez",
    email: "jose@example.com",
  }),
  // A placeholder record with no email at all.
  person({ id: "tm-org", name: "Brookline Interactive Group" }),
];

describe("filterReservablePeople", () => {
  it("returns everyone for an empty or whitespace query", () => {
    expect(filterReservablePeople(PEOPLE, "")).toEqual(PEOPLE);
    expect(filterReservablePeople(PEOPLE, "   ")).toEqual(PEOPLE);
  });

  it("finds people by surname, not just first name", () => {
    expect(filterReservablePeople(PEOPLE, "jansen").map((p) => p.id)).toEqual([
      "neon:bea.jansen@example.com",
    ]);
  });

  it("finds people by email", () => {
    expect(
      filterReservablePeople(PEOPLE, "dee@example").map((p) => p.id)
    ).toEqual(["tm-staff"]);
  });

  it("matches every word, in any order", () => {
    expect(
      filterReservablePeople(PEOPLE, "jansen bea").map((p) => p.id)
    ).toEqual(["neon:bea.jansen@example.com"]);
    // Both words must match the SAME person.
    expect(filterReservablePeople(PEOPLE, "bea dee")).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(filterReservablePeople(PEOPLE, "ALVAREZ").map((p) => p.id)).toEqual([
      "neon:jose@example.com",
    ]);
    expect(filterReservablePeople(PEOPLE, "josé").map((p) => p.id)).toEqual([
      "neon:jose@example.com",
    ]);
  });

  it("searches people who have no email by name", () => {
    expect(
      filterReservablePeople(PEOPLE, "brookline").map((p) => p.id)
    ).toEqual(["tm-org"]);
  });

  it("returns nothing when nobody matches", () => {
    expect(filterReservablePeople(PEOPLE, "zzz")).toEqual([]);
  });
});

describe("neon custodian ids", () => {
  it("round-trips an email, normalising case and whitespace", () => {
    const id = neonCustodianIdForEmail("  Bea.Jansen@Example.com ");
    expect(id).toBe("neon:bea.jansen@example.com");
    expect(isNeonCustodianId(id)).toBe(true);
    expect(emailFromNeonCustodianId(id)).toBe("bea.jansen@example.com");
  });

  it("does not mistake an ordinary team member id for a directory id", () => {
    expect(isNeonCustodianId("clx1abc2def3")).toBe(false);
  });
});
