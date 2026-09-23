import { describe, expect, it } from "vitest";
import { getReserveDisabled } from "./reserve-state";

const ready = {
  disabled: false,
  isProcessing: false,
  isLoadingWorkingHours: false,
  bookingFlags: {
    hasAssets: true,
    hasAlreadyBookedAssets: false,
    hasUnavailableAssets: false,
  },
};

describe("getReserveDisabled — one rule for both Reserve buttons", () => {
  it("allows reserving a draft with available items", () => {
    expect(getReserveDisabled(ready)).toBe(false);
  });

  it("asks for items when there are none", () => {
    expect(
      getReserveDisabled({
        ...ready,
        bookingFlags: { ...ready.bookingFlags, hasAssets: false },
      })
    ).toEqual({
      reason:
        "You need to add assets to your booking before you can reserve it",
    });
  });

  it("explains a clash with another booking", () => {
    const result = getReserveDisabled({
      ...ready,
      bookingFlags: { ...ready.bookingFlags, hasAlreadyBookedAssets: true },
    });
    expect(result && result.reason).toMatch(/already booked/);
  });

  it("explains unavailable items first", () => {
    const result = getReserveDisabled({
      ...ready,
      bookingFlags: {
        ...ready.bookingFlags,
        hasAlreadyBookedAssets: true,
        hasUnavailableAssets: true,
      },
    });
    expect(result && result.reason).toMatch(/unavailble/);
  });

  it("is disabled without a reason while a save is in flight", () => {
    expect(
      getReserveDisabled({ ...ready, disabled: true, isProcessing: true })
    ).toEqual({ reason: undefined });
  });
});
