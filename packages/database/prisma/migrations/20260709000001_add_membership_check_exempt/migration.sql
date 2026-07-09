-- BIG: per-membership exemption from the active-Neon-membership reserve gate.
-- Admins invite non-Neon users (volunteers, partners) with "doesn't require a
-- membership" ticked; those members bypass the Neon check and the sync reconcile.
-- Additive, defaulted → existing rows get false; safe, non-breaking.

ALTER TABLE "UserOrganization" ADD COLUMN "membershipCheckExempt" BOOLEAN NOT NULL DEFAULT false;

-- Carries the admin's choice from invite creation to acceptance (copied onto the
-- new UserOrganization when the invite is accepted).
ALTER TABLE "Invite" ADD COLUMN "membershipCheckExempt" BOOLEAN NOT NULL DEFAULT false;
