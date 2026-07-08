/**
 * BIG Loan Agreement — service (server-only)
 *
 * The per-workspace equipment loan agreement and its per-checkout signatures:
 * - The **template** is the org's current terms (editable by admins; seeded from
 *   the default). Merge fields (`{{...}}`) are filled with each booking's
 *   specifics at signing time.
 * - A **signature** is an immutable record that a borrower e-signed the agreement
 *   for a specific booking checkout. It snapshots exactly what was signed (title,
 *   version, filled content) plus signer + timestamp + IP, so later template
 *   edits never change what someone already agreed to.
 *
 * The checkout flow gates on {@link hasSignedForBooking}; the gate is a no-op for
 * any org that has no template configured, so it's opt-in per workspace.
 *
 * @see {@link file://./default-agreement.ts}
 * @see {@link file://./../booking/service.server.ts} — the checkout gate
 */
import type { LoanAgreementTemplate } from "@prisma/client";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import {
  DEFAULT_LOAN_AGREEMENT_MARKDOWN,
  DEFAULT_LOAN_AGREEMENT_TITLE,
  DEFAULT_LOAN_AGREEMENT_VERSION,
} from "./default-agreement";

const label = "Loan Agreement" as const;

/** Booking specifics substituted into the agreement's merge fields at signing. */
export type AgreementMergeData = {
  organizationName: string;
  borrowerName: string;
  borrowerEmail: string;
  /** A Markdown bullet list of the reserved equipment. */
  equipmentList: string;
  checkoutDate: string;
  dueDate: string;
};

/**
 * Fills the `{{MERGE_FIELDS}}` in an agreement body with a booking's specifics.
 *
 * @param content - The template Markdown (may contain merge fields)
 * @param data - The booking/borrower values to substitute
 * @returns The personalized agreement Markdown
 */
export function fillAgreement(
  content: string,
  data: AgreementMergeData
): string {
  return content
    .replaceAll("{{ORGANIZATION_NAME}}", data.organizationName)
    .replaceAll("{{BORROWER_NAME}}", data.borrowerName)
    .replaceAll("{{BORROWER_EMAIL}}", data.borrowerEmail)
    .replaceAll("{{EQUIPMENT_LIST}}", data.equipmentList)
    .replaceAll("{{CHECKOUT_DATE}}", data.checkoutDate)
    .replaceAll("{{DUE_DATE}}", data.dueDate);
}

/**
 * Returns the org's agreement template, or `null` if none is configured. When
 * `null`, the checkout gate is a no-op (agreements are opt-in per workspace).
 *
 * @param organizationId - The workspace id
 */
export async function getActiveTemplate(
  organizationId: string
): Promise<LoanAgreementTemplate | null> {
  return db.loanAgreementTemplate.findUnique({ where: { organizationId } });
}

/**
 * Returns the org's agreement template, creating it from the default on first
 * use. Use this from surfaces that need a template to exist (admin editor,
 * signing page); use {@link getActiveTemplate} where a missing template should
 * mean "no agreement required".
 *
 * @param args.organizationId - The workspace id
 * @param args.userId - The user recorded as the template's creator
 * @throws {ShelfError} If the create fails
 */
export async function getOrSeedTemplate({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): Promise<LoanAgreementTemplate> {
  const existing = await getActiveTemplate(organizationId);
  if (existing) {
    return existing;
  }

  try {
    return await db.loanAgreementTemplate.create({
      data: {
        organizationId,
        title: DEFAULT_LOAN_AGREEMENT_TITLE,
        content: DEFAULT_LOAN_AGREEMENT_MARKDOWN,
        version: DEFAULT_LOAN_AGREEMENT_VERSION,
        createdById: userId,
      },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not create the loan agreement template",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Whether a loan agreement has been signed for a booking (org-scoped).
 *
 * @param args.bookingId - The booking id
 * @param args.organizationId - The caller's org (scoping guard)
 */
export async function hasSignedForBooking({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: string;
}): Promise<boolean> {
  const count = await db.loanAgreementSignature.count({
    where: { bookingId, organizationId },
  });
  return count > 0;
}

/**
 * The most recent signature for a booking, or `null` (org-scoped).
 *
 * @param args.bookingId - The booking id
 * @param args.organizationId - The caller's org (scoping guard)
 */
export async function getSignatureForBooking({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: string;
}) {
  return db.loanAgreementSignature.findFirst({
    where: { bookingId, organizationId },
    orderBy: { signedAt: "desc" },
  });
}

/**
 * Records an immutable signature for a booking checkout.
 *
 * @param args - The signer, booking, template snapshot, filled content, and
 *   request metadata (IP / user agent) captured for the audit trail
 * @throws {ShelfError} If the write fails
 */
export async function recordSignature(args: {
  organizationId: string;
  bookingId: string;
  signedByUserId: string;
  signerName: string;
  signerEmail: string;
  template: Pick<LoanAgreementTemplate, "title" | "version">;
  contentSnapshot: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  try {
    return await db.loanAgreementSignature.create({
      data: {
        organizationId: args.organizationId,
        bookingId: args.bookingId,
        signedByUserId: args.signedByUserId,
        signerName: args.signerName,
        signerEmail: args.signerEmail,
        agreementTitle: args.template.title,
        agreementVersion: args.template.version,
        contentSnapshot: args.contentSnapshot,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
      },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not record the signed loan agreement",
      additionalData: { bookingId: args.bookingId },
      label,
    });
  }
}
