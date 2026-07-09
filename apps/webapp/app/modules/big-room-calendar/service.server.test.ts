import { beforeEach, describe, expect, it, vi } from "vitest";

// why: stub the DB so booking lookups return fixtures, not real rows.
vi.mock("~/database/db.server", () => ({
  db: { booking: { findUnique: vi.fn(), findMany: vi.fn() } },
}));
// why: stub the Google client so no real HTTP happens; assert the calls made.
vi.mock("~/integrations/google-calendar/client.server", () => ({
  isGoogleCalendarConfigured: vi.fn(() => true),
  upsertCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  listUpcomingCalendarEventIds: vi.fn(() => []),
}));
vi.mock("~/utils/logger", () => ({ Logger: { error: vi.fn() } }));

import { db } from "~/database/db.server";
import {
  deleteCalendarEvent,
  isGoogleCalendarConfigured,
  upsertCalendarEvent,
} from "~/integrations/google-calendar/client.server";
import { Logger } from "~/utils/logger";

import {
  buildRoomEvent,
  decodeRoomEventId,
  deleteBookingRoomEvents,
  googleColorIdForHex,
  roomEventId,
  upsertBookingRoomEvents,
} from "./service.server";

const mf = (f: unknown) => f as ReturnType<typeof vi.fn>;

/** A booking fixture in the calendar select shape. */
const booking = (overrides: Record<string, unknown> = {}) => ({
  id: "bk1",
  name: "Podcast session",
  from: new Date("2026-07-10T14:00:00Z"),
  to: new Date("2026-07-10T16:00:00Z"),
  status: "RESERVED",
  custodianUser: { firstName: "Jane", lastName: "Doe", email: "j@d.io" },
  custodianTeamMember: null,
  rooms: [{ id: "rm1", name: "Podcast Room", color: "#8a6de2" }],
  _count: { assets: 3 },
  ...overrides,
});

describe("roomEventId / decodeRoomEventId", () => {
  it("round-trips and stays inside Google's base32hex alphabet", () => {
    const id = roomEventId("bkWxyZ123", "rmQrs789");
    // Hex encoding → only [0-9a-f], a strict subset of Google's [a-v0-9].
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(decodeRoomEventId(id)).toEqual({
      bookingId: "bkWxyZ123",
      roomId: "rmQrs789",
    });
  });

  it("returns null for ids we didn't create", () => {
    expect(decodeRoomEventId("some-manual-event")).toBeNull(); // not hex
    expect(decodeRoomEventId("abc")).toBeNull(); // odd length
    // Valid hex but no "bookingId:roomId" payload inside.
    expect(
      decodeRoomEventId(Buffer.from("no-separator").toString("hex"))
    ).toBeNull();
  });
});

describe("googleColorIdForHex", () => {
  it("maps a room color to one of Google's 11 colors", () => {
    const id = googleColorIdForHex("#8a6de2");
    expect(Number(id)).toBeGreaterThanOrEqual(1);
    expect(Number(id)).toBeLessThanOrEqual(11);
  });

  it("returns undefined for missing or unparsable colors", () => {
    expect(googleColorIdForHex(null)).toBeUndefined();
    expect(googleColorIdForHex("rebeccapurple")).toBeUndefined();
  });
});

describe("buildRoomEvent", () => {
  it("builds a deterministic, room-labeled event", () => {
    const event = buildRoomEvent(booking() as never, {
      id: "rm1",
      name: "Podcast Room",
      color: "#8a6de2",
    });
    expect(event).toMatchObject({
      id: roomEventId("bk1", "rm1"),
      summary: "Podcast Room — Podcast session",
      location: "Podcast Room",
      status: "confirmed",
    });
    expect(event?.description).toContain("Jane Doe");
    expect(event?.description).toContain("/bookings/bk1");
  });

  it("returns null when the booking has no usable time window", () => {
    expect(
      buildRoomEvent(booking({ from: null }) as never, {
        id: "rm1",
        name: "Podcast Room",
        color: null,
      })
    ).toBeNull();
  });
});

describe("upsertBookingRoomEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isGoogleCalendarConfigured).mockReturnValue(true);
  });

  it("pushes one event per room for an active booking", async () => {
    mf(db.booking.findUnique).mockResolvedValue(
      booking({
        rooms: [
          { id: "rm1", name: "Podcast Room", color: "#8a6de2" },
          { id: "rm2", name: "Studio A", color: "#9cd805" },
        ],
      })
    );
    await upsertBookingRoomEvents({ bookingId: "bk1" });
    expect(upsertCalendarEvent).toHaveBeenCalledTimes(2);
  });

  it("no-ops for drafts (no events until reserve)", async () => {
    mf(db.booking.findUnique).mockResolvedValue(booking({ status: "DRAFT" }));
    await upsertBookingRoomEvents({ bookingId: "bk1" });
    expect(upsertCalendarEvent).not.toHaveBeenCalled();
  });

  it("no-ops when the integration isn't configured", async () => {
    mf(isGoogleCalendarConfigured).mockReturnValue(false);
    await upsertBookingRoomEvents({ bookingId: "bk1" });
    expect(db.booking.findUnique).not.toHaveBeenCalled();
    expect(upsertCalendarEvent).not.toHaveBeenCalled();
  });

  it("never throws — a Google failure is logged, not raised", async () => {
    mf(db.booking.findUnique).mockResolvedValue(booking());
    mf(upsertCalendarEvent).mockRejectedValue(new Error("google 500"));
    await expect(
      upsertBookingRoomEvents({ bookingId: "bk1" })
    ).resolves.toBeUndefined();
    expect(Logger.error).toHaveBeenCalled();
  });
});

describe("deleteBookingRoomEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mf(isGoogleCalendarConfigured).mockReturnValue(true);
  });

  it("deletes the events for explicitly-passed rooms without a DB lookup", async () => {
    await deleteBookingRoomEvents({
      bookingId: "bk1",
      roomIds: ["rm1", "rm2"],
    });
    expect(db.booking.findUnique).not.toHaveBeenCalled();
    expect(deleteCalendarEvent).toHaveBeenCalledWith(roomEventId("bk1", "rm1"));
    expect(deleteCalendarEvent).toHaveBeenCalledWith(roomEventId("bk1", "rm2"));
  });

  it("looks up the booking's rooms when ids are omitted", async () => {
    mf(db.booking.findUnique).mockResolvedValue({ rooms: [{ id: "rm9" }] });
    await deleteBookingRoomEvents({ bookingId: "bk1" });
    expect(deleteCalendarEvent).toHaveBeenCalledWith(roomEventId("bk1", "rm9"));
  });

  it("never throws — a Google failure is logged, not raised", async () => {
    mf(deleteCalendarEvent).mockRejectedValue(new Error("google 500"));
    await expect(
      deleteBookingRoomEvents({ bookingId: "bk1", roomIds: ["rm1"] })
    ).resolves.toBeUndefined();
    expect(Logger.error).toHaveBeenCalled();
  });
});
