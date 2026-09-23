import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import {
  buildAgreementForBooking,
  getActiveTemplate,
  getSignatureForBooking,
  recordSignature,
} from "~/modules/big-loan-agreement/service.server";
import { action } from "~/routes/_layout+/loan-agreement.$bookingId";
import { requirePermission } from "~/utils/roles.server";

// why: who is asking (staff or member) is the decision under test.
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));

// why: building the agreement and writing the signature are the service's
// job (tested there); here we check what the route decides to record.
vi.mock("~/modules/big-loan-agreement/service.server", () => ({
  buildAgreementForBooking: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSignatureForBooking: vi.fn(),
  getSignatureSummary: vi.fn(),
  recordSignature: vi.fn(),
}));

// why: the success toast is a side channel, not the behaviour under test.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));

const record = vi.mocked(recordSignature);

function as({ staff }: { staff: boolean }) {
  vi.mocked(requirePermission).mockResolvedValue({
    organizationId: "org-big",
    role: staff ? "ADMIN" : "MEMBER",
    currentOrganization: { name: "BIG" },
    isSelfServiceOrBase: !staff,
  } as any);
}

function submit(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return action(
    createActionArgs({
      request: new Request("http://localhost:3000/loan-agreement/b1", {
        method: "POST",
        body,
      }),
      params: { bookingId: "b1" },
      context: { getSession: () => ({ userId: "u-1" }) } as any,
    })
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSignatureForBooking).mockResolvedValue(null);
  vi.mocked(getActiveTemplate).mockResolvedValue({ id: "t1" } as any);
  vi.mocked(buildAgreementForBooking).mockResolvedValue({
    booking: { id: "b1" },
    template: { title: "Equipment Loan Agreement", version: 1 },
    filledContent: "terms incl. equipment and supplies",
    borrowerName: "Ava Whitfield",
    borrowerEmail: "ava@example.com",
    items: { assets: [], supplies: [] },
  } as any);
});

describe("loan agreement — paper instead of e-signature", () => {
  it("lets staff record a signature made on a printed copy, then returns them to the booking", async () => {
    as({ staff: true });

    const response = await submit({
      intent: "paper",
      paperSignerName: "Ava Whitfield",
      witnessed: "on",
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PAPER",
        signerName: "Ava Whitfield",
        signerEmail: "ava@example.com",
        signedByUserId: "u-1",
        contentSnapshot: "terms incl. equipment and supplies",
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/bookings/b1");
  });

  it("refuses a paper signature from a member, recording nothing", async () => {
    as({ staff: false });

    const response = await submit({
      intent: "paper",
      paperSignerName: "Ava Whitfield",
      witnessed: "on",
    });

    expect(response.init?.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("needs staff to confirm the borrower actually signed the paper copy", async () => {
    as({ staff: true });

    const response = await submit({
      intent: "paper",
      paperSignerName: "Ava Whitfield",
    });

    expect(response.init?.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("still lets members e-sign, returning them to their reservations", async () => {
    as({ staff: false });

    const response = await submit({ signerName: "Ava Whitfield", agree: "on" });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DIGITAL",
        signerName: "Ava Whitfield",
      })
    );
    expect(response.headers.get("Location")).toBe("/reserve?signed=1");
  });

  it("records nothing twice", async () => {
    as({ staff: true });
    vi.mocked(getSignatureForBooking).mockResolvedValue({ id: "sig" } as any);

    const response = await submit({
      intent: "paper",
      paperSignerName: "Ava Whitfield",
      witnessed: "on",
    });

    expect(record).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toBe("/bookings/b1");
  });
});
