import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";
import { db } from "~/database/db.server";
import { createAsset } from "~/modules/asset/service.server";
import { sendBookingUpdatedEmail } from "~/modules/booking/email-helpers";
import { updateBookingAssets } from "~/modules/booking/service.server";
import { action } from "~/routes/_layout+/assets.new";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { requirePermission } from "~/utils/roles.server";

// why: permission checks are not under test; staff are creating an asset.
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));

// why: the only tables the route reads directly are Booking and Kit.
vi.mock("~/database/db.server", () => ({
  db: { booking: { findFirst: vi.fn() }, kit: { findFirst: vi.fn() } },
}));

// why: asset creation (sequential ids, QR codes) and image upload are the
// asset service's job; here we check the booking hand-off around them.
vi.mock("~/modules/asset/service.server", () => ({
  createAsset: vi.fn(),
  updateAssetMainImage: vi.fn(),
  getAllEntriesForCreateAndEdit: vi.fn(),
}));

// why: loader-only dependencies of the route module.
vi.mock("~/modules/asset/sequential-id.server", () => ({
  estimateNextSequentialId: vi.fn(),
}));
vi.mock("~/modules/qr/service.server", () => ({
  assertWhetherQrBelongsToCurrentOrganization: vi.fn(),
}));

// why: no custom fields, so the plain asset schema applies.
vi.mock("~/modules/custom-field/service.server", () => ({
  getActiveCustomFields: vi.fn().mockResolvedValue([]),
}));

// why: adding to a booking is the booking service's job; we check it's asked.
vi.mock("~/modules/booking/service.server", () => ({
  updateBookingAssets: vi.fn(),
}));
vi.mock("~/modules/booking/email-helpers", () => ({
  sendBookingUpdatedEmail: vi.fn(),
}));

// why: notes, toasts and logs are side channels.
vi.mock("~/modules/note/service.server", () => ({ createNote: vi.fn() }));
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));
vi.mock("~/utils/logger", () => ({
  Logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    handledClientError: vi.fn(),
  },
}));

const create = vi.mocked(createAsset);
const addToBooking = vi.mocked(updateBookingAssets);

function submit(query = "?booking=b1") {
  const body = new FormData();
  body.set("title", "Rode NTG3");
  body.set("description", "Shotgun microphone");
  body.set("category", "cat-audio");
  return action(
    createActionArgs({
      request: new Request(`http://localhost:3000/assets/new${query}`, {
        method: "POST",
        body,
      }),
      context: { getSession: () => ({ userId: "u-staff" }) } as any,
    })
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    organizationId: "org-big",
    canUseBarcodes: false,
  } as any);
  vi.mocked(db.booking.findFirst).mockResolvedValue({
    id: "b1",
    name: "Doc shoot",
    status: "DRAFT",
  } as any);
  create.mockResolvedValue({
    id: "asset-new",
    title: "Rode NTG3",
    location: null,
    user: { firstName: "Dee", lastName: "Admin" },
  } as any);
  addToBooking.mockResolvedValue({ id: "b1", name: "Doc shoot" } as any);
});

describe("new asset straight into a booking (?booking=)", () => {
  it("creates the asset, adds it to the booking, and returns to the booking", async () => {
    const response = await submit();

    expect(create).toHaveBeenCalledTimes(1);
    expect(addToBooking).toHaveBeenCalledWith({
      id: "b1",
      organizationId: "org-big",
      assetIds: ["asset-new"],
      userId: "u-staff",
    });
    expect(sendBookingUpdatedEmail).toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/bookings/b1");
  });

  it("only looks the booking up inside the caller's organization", async () => {
    await submit();
    expect(vi.mocked(db.booking.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "b1", organizationId: "org-big" },
    });
  });

  it("creates nothing for a booking in another workspace", async () => {
    vi.mocked(db.booking.findFirst).mockResolvedValue(null);

    const response = await submit();

    expect(response.init?.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates nothing for a booking that is already closed", async () => {
    vi.mocked(db.booking.findFirst).mockResolvedValue({
      id: "b1",
      name: "Doc shoot",
      status: "COMPLETE",
    } as any);

    const response = await submit();

    expect(response.init?.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("still returns to the booking, saying so, if the asset couldn't be added", async () => {
    addToBooking.mockRejectedValue(new Error("booking changed meanwhile"));

    const response = await submit();

    expect(create).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Location")).toBe("/bookings/b1");
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Asset created, but not added" })
    );
  });

  it("behaves exactly as before without ?booking=", async () => {
    const response = await submit("");

    expect(addToBooking).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toBe("/assets");
  });
});
