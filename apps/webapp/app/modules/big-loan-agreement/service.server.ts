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
 * - BIG: staff can instead **print** the agreement for an in-person signature and
 *   record the paper copy ({@link LoanAgreementSignatureMethod} `PAPER`). Either
 *   kind satisfies the checkout gate.
 * - BIG: the agreement lists everything the borrower takes away — equipment
 *   (with the code on its label) AND supplies — on screen, on paper, and in the
 *   stored snapshot. See {@link getLoanItems}.
 *
 * The checkout flow gates on {@link hasSignedForBooking}; the gate is a no-op for
 * any org that has no template configured, so it's opt-in per workspace.
 *
 * @see {@link file://./default-agreement.ts}
 * @see {@link file://./../booking/service.server.ts} — the checkout gate
 */
import type {
  LoanAgreementSignatureMethod,
  LoanAgreementTemplate,
} from "@prisma/client";
import { db } from "~/database/db.server";
import type {
  OrganizationForCodeResolution,
  ResolvedDisplayCode,
} from "~/modules/barcode/display";
import { resolveDisplayCode } from "~/modules/barcode/display";
import { getBookingSupplies } from "~/modules/big-supply/service.server";
import { validateBookingOwnership } from "~/utils/booking-authorization.server";
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
  /** A Markdown list of the equipment and supplies — see {@link formatLoanItemsMarkdown}. */
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
 * Whether a booking still needs its loan agreement signed before it can be
 * checked out. BIG enforces the agreement on **every** reservation, so this is
 * `true` for any unsigned booking once the workspace has a template. Returns
 * `false` (no signature required) only when:
 * - the workspace has no agreement template (agreements are opt-in per org), or
 * - the booking already has a signature.
 *
 * Single source of truth for both the checkout gate
 * ({@link file://./../booking/service.server.ts}) and the proactive
 * "sign first" banner on the booking page, so the two never disagree.
 *
 * @param args.bookingId - The booking to evaluate
 * @param args.organizationId - The caller's workspace (scoping guard)
 * @returns `true` when a signature is still required before checkout
 */
export async function bookingNeedsAgreementSignature({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: string;
}): Promise<boolean> {
  // Opt-in: no template configured for this workspace → never required.
  const template = await getActiveTemplate(organizationId);
  if (!template) {
    return false;
  }

  // Every reservation is gated → required only until it has been signed.
  return !(await hasSignedForBooking({ bookingId, organizationId }));
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
  /**
   * BIG: `PAPER` when the borrower signed a printed copy in person and a staff
   * member is recording it (`signedByUserId` is then that staff member).
   */
  method?: LoanAgreementSignatureMethod;
}) {
  try {
    return await db.loanAgreementSignature.create({
      data: {
        method: args.method ?? "DIGITAL",
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

/** One piece of equipment on a loan, with the code printed on its label. */
export type LoanAsset = {
  id: string;
  title: string;
  /** Resolved per the workspace's label preference; see `resolveDisplayCode`. */
  code: ResolvedDisplayCode;
};

/** One supply line on a loan. */
export type LoanSupply = {
  id: string;
  name: string;
  quantity: number;
  /** Consumables (batteries, tape) are not expected back. */
  isConsumable: boolean;
};

/** Everything the borrower takes away on a booking. */
export type LoanItems = { assets: LoanAsset[]; supplies: LoanSupply[] };

/**
 * Loads everything a borrower takes away on a booking: its equipment (with the
 * code on each item's label, so staff can match paper to shelf) and its supply
 * lines. Both are scoped to the organization.
 *
 * @param args.bookingId - The booking.
 * @param args.organizationId - The caller's organization.
 * @param args.organization - Its label-code preferences.
 * @returns The equipment (A–Z) and supplies (by category, then name).
 */
export async function getLoanItems({
  bookingId,
  organizationId,
  organization,
}: {
  bookingId: string;
  organizationId: string;
  organization: OrganizationForCodeResolution;
}): Promise<LoanItems> {
  const [assets, supplies] = await Promise.all([
    db.asset.findMany({
      where: { organizationId, bookings: { some: { id: bookingId } } },
      select: {
        id: true,
        title: true,
        sequentialId: true,
        preferredBarcodeId: true,
        qrCodes: { take: 1, select: { id: true } },
        barcodes: { select: { id: true, type: true, value: true } },
      },
      orderBy: { title: "asc" },
    }),
    getBookingSupplies({ bookingId, organizationId }),
  ]);

  return {
    assets: assets.map((asset) => ({
      id: asset.id,
      title: asset.title,
      code: resolveDisplayCode({ entity: asset, organization }),
    })),
    supplies: supplies.map((line) => ({
      id: line.id,
      name: line.name,
      quantity: line.quantity,
      isConsumable: line.isConsumable,
    })),
  };
}

/**
 * The item list as Markdown, for the agreement's `{{EQUIPMENT_LIST}}` field —
 * and therefore for the snapshot stored with every signature, so the record
 * says exactly what was lent, not just "the booking".
 *
 * Only adds "Equipment" / "Supplies" sub-headings when a loan has supplies, so
 * an equipment-only agreement reads exactly as it always has.
 *
 * @param items - What {@link getLoanItems} returned.
 * @returns Markdown bullet lists.
 */
export function formatLoanItemsMarkdown(items: LoanItems): string {
  const assetLines = items.assets.map(
    (asset) =>
      `- ${asset.title}${asset.code.value ? ` (${asset.code.value})` : ""}`
  );
  const supplyLines = items.supplies.map(
    (supply) => `- ${supply.quantity} × ${supply.name}`
  );

  if (supplyLines.length === 0) {
    return assetLines.length
      ? assetLines.join("\n")
      : "- (equipment will be listed at checkout)";
  }

  const sections = [];
  if (assetLines.length) {
    sections.push(`**Equipment**\n\n${assetLines.join("\n")}`);
  }
  sections.push(`**Supplies**\n\n${supplyLines.join("\n")}`);
  return sections.join("\n\n");
}

/** Formats a date for the agreement body (e.g. "July 7, 2026"). */
function formatAgreementDate(date: Date | null): string {
  if (!date) {
    return "the date of checkout";
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Builds a booking's filled agreement: loads the booking (org-scoped and
 * ownership-checked), its items and the template, and fills the merge fields.
 * Shared by the signing page and the printable copy so the paper version is
 * word-for-word what would be e-signed.
 *
 * @param args.bookingId - The booking.
 * @param args.organizationId - The caller's organization.
 * @param args.organization - Its name and label-code preferences.
 * @param args.userId - The caller, for the ownership check.
 * @param args.role - The caller's role, for the ownership check.
 * @returns The booking, template, filled Markdown, borrower and items.
 * @throws {ShelfError} 404 when the booking is not in this organization; 403
 *   when the caller may not act on it.
 */
export async function buildAgreementForBooking({
  bookingId,
  organizationId,
  organization,
  userId,
  role,
}: {
  bookingId: string;
  organizationId: string;
  organization: OrganizationForCodeResolution & { name: string };
  userId: string;
  role: Parameters<typeof validateBookingOwnership>[0]["role"];
}) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, organizationId },
    select: {
      id: true,
      name: true,
      from: true,
      to: true,
      creatorId: true,
      custodianUserId: true,
      custodianUser: {
        select: { firstName: true, lastName: true, email: true },
      },
      // A booking made for a member with no account has no custodianUser.
      // Their name is on the team member, and their email on its directory
      // link — without these the agreement named "the borrower", no email.
      custodianTeamMember: {
        select: { name: true, directoryLink: { select: { email: true } } },
      },
    },
  });

  if (!booking) {
    throw new ShelfError({
      cause: null,
      message: "That reservation could not be found.",
      label,
      status: 404,
      shouldBeCaptured: false,
    });
  }

  // The borrower (or staff) may only act on their own booking.
  validateBookingOwnership({
    booking: {
      creatorId: booking.creatorId,
      custodianUserId: booking.custodianUserId,
    },
    userId,
    role,
    action: "sign the loan agreement for",
  });

  const [template, items] = await Promise.all([
    getOrSeedTemplate({ organizationId, userId }),
    getLoanItems({ bookingId, organizationId, organization }),
  ]);

  const borrowerName =
    [booking.custodianUser?.firstName, booking.custodianUser?.lastName]
      .filter(Boolean)
      .join(" ") ||
    booking.custodianTeamMember?.name ||
    "the borrower";
  const borrowerEmail =
    booking.custodianUser?.email ??
    booking.custodianTeamMember?.directoryLink?.email ??
    "";

  const filledContent = fillAgreement(template.content, {
    organizationName: organization.name,
    borrowerName,
    borrowerEmail,
    equipmentList: formatLoanItemsMarkdown(items),
    checkoutDate: formatAgreementDate(booking.from),
    dueDate: formatAgreementDate(booking.to),
  });

  return {
    booking,
    template,
    filledContent,
    borrowerName,
    borrowerEmail,
    items,
  };
}

/**
 * How a booking's agreement was signed, for display: who signed, when, and —
 * for a paper copy — which staff member recorded it.
 *
 * @param args.bookingId - The booking.
 * @param args.organizationId - The caller's organization.
 * @returns The latest signature, or `null` when unsigned.
 */
export async function getSignatureSummary({
  bookingId,
  organizationId,
}: {
  bookingId: string;
  organizationId: string;
}): Promise<{
  method: LoanAgreementSignatureMethod;
  signerName: string;
  signedAt: Date;
  /** The staff member who recorded a paper signature; null when digital. */
  recordedBy: string | null;
} | null> {
  const signature = await getSignatureForBooking({ bookingId, organizationId });
  if (!signature) return null;

  let recordedBy: string | null = null;
  if (signature.method === "PAPER") {
    const staff = await db.user.findUnique({
      where: { id: signature.signedByUserId },
      select: { firstName: true, lastName: true, email: true },
    });
    recordedBy =
      [staff?.firstName, staff?.lastName].filter(Boolean).join(" ") ||
      staff?.email ||
      null;
  }

  return {
    method: signature.method,
    signerName: signature.signerName,
    signedAt: signature.signedAt,
    recordedBy,
  };
}
