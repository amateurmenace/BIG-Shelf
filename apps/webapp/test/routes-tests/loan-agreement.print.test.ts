import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { buildAgreementForBooking } from "~/modules/big-loan-agreement/service.server";
import { loader } from "~/routes/loan-agreement.$bookingId.print";
import { requirePermission } from "~/utils/roles.server";

// why: who is asking (staff or member) is the decision under test.
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));

// why: the agreement itself is built and tested in the service.
vi.mock("~/modules/big-loan-agreement/service.server", () => ({
  buildAgreementForBooking: vi.fn(),
}));

function as({ staff }: { staff: boolean }) {
  vi.mocked(requirePermission).mockResolvedValue({
    organizationId: "org-big",
    role: staff ? "ADMIN" : "MEMBER",
    currentOrganization: {
      name: "BIG",
      qrIdDisplayPreference: "SAM_ID",
      barcodesEnabled: false,
    },
    isSelfServiceOrBase: !staff,
  } as any);
}

function load() {
  return loader(
    createLoaderArgs({
      request: new Request("http://localhost:3000/loan-agreement/b1/print"),
      params: { bookingId: "b1" },
      context: { getSession: () => ({ userId: "u-1" }) } as any,
    })
  ) as Promise<any>;
}

const ITEMS = {
  assets: [{ id: "a1", title: "Canon C70", code: { value: "SAM-0042" } }],
  supplies: [
    { id: "s1", name: "AA batteries", quantity: 4, isConsumable: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildAgreementForBooking).mockResolvedValue({
    booking: {
      id: "b1",
      name: "Doc shoot",
      from: new Date("2026-09-24T14:00:00Z"),
      to: new Date("2026-09-25T14:00:00Z"),
    },
    template: { title: "Equipment Loan Agreement", version: 3 },
    filledContent: "# Equipment Loan Agreement",
    borrowerName: "Ava Whitfield",
    borrowerEmail: "ava@example.com",
    items: ITEMS,
  } as any);
});

describe("printable loan agreement", () => {
  it("gives staff the whole agreement, with the equipment AND supplies", async () => {
    as({ staff: true });

    const response = await load();

    expect(response.data).toMatchObject({
      title: "Equipment Loan Agreement",
      version: 3,
      bookingName: "Doc shoot",
      borrowerName: "Ava Whitfield",
      items: ITEMS,
    });
    expect(response.data.agreementTree).toBeTruthy();
  });

  it("is staff-only — members e-sign instead", async () => {
    as({ staff: false });

    await expect(load()).rejects.toMatchObject({ init: { status: 403 } });
    expect(buildAgreementForBooking).not.toHaveBeenCalled();
  });
});
