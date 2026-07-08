/**
 * Tests for {@link validateBookingOwnership}.
 *
 * Focus: the BIG `MEMBER` role must be ownership-checked exactly like
 * `SELF_SERVICE`. Before the fix, `MEMBER` fell through to the ADMIN/OWNER
 * "implicitly allowed" branch and could act on any booking in the org — a
 * cross-user authorization gap these tests lock down.
 *
 * @see {@link file://./booking-authorization.server.ts}
 */
import { OrganizationRoles } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { validateBookingOwnership } from "./booking-authorization.server";

/** A booking created by and assigned to user "u1". */
const ownBooking = { creatorId: "u1", custodianUserId: "u1" };
/** A booking created by and assigned to a different user, "u2". */
const othersBooking = { creatorId: "u2", custodianUserId: "u2" };

describe("validateBookingOwnership", () => {
  describe("MEMBER role", () => {
    it("allows a member to act on a booking they own", () => {
      expect(() =>
        validateBookingOwnership({
          booking: ownBooking,
          userId: "u1",
          role: OrganizationRoles.MEMBER,
          action: "delete",
        })
      ).not.toThrow();
    });

    it("blocks a member from acting on another user's booking (regression: MEMBER used to bypass the check)", () => {
      expect(() =>
        validateBookingOwnership({
          booking: othersBooking,
          userId: "u1",
          role: OrganizationRoles.MEMBER,
          action: "delete",
        })
      ).toThrow();
    });

    it("honors checkCustodianOnly: a member who is the custodian but not the creator is allowed", () => {
      expect(() =>
        validateBookingOwnership({
          booking: { creatorId: "u2", custodianUserId: "u1" },
          userId: "u1",
          role: OrganizationRoles.MEMBER,
          action: "download",
          checkCustodianOnly: true,
        })
      ).not.toThrow();
    });
  });

  describe("parity with SELF_SERVICE", () => {
    it("blocks a self-service user from acting on another user's booking", () => {
      expect(() =>
        validateBookingOwnership({
          booking: othersBooking,
          userId: "u1",
          role: OrganizationRoles.SELF_SERVICE,
          action: "delete",
        })
      ).toThrow();
    });
  });

  describe("ADMIN / OWNER", () => {
    it("allows admins and owners to act on any booking", () => {
      for (const role of [
        OrganizationRoles.ADMIN,
        OrganizationRoles.OWNER,
      ] as const) {
        expect(() =>
          validateBookingOwnership({
            booking: othersBooking,
            userId: "u1",
            role,
            action: "delete",
          })
        ).not.toThrow();
      }
    });
  });

  describe("BASE role", () => {
    it("is blocked entirely from destructive actions when blockBaseEntirely is set, even on their own booking", () => {
      expect(() =>
        validateBookingOwnership({
          booking: ownBooking,
          userId: "u1",
          role: OrganizationRoles.BASE,
          action: "extend",
          blockBaseEntirely: true,
        })
      ).toThrow();
    });
  });
});
