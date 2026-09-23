import type { FormEvent, ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReserveReminder } from "./reserve-reminder";

/** The booking page's form, as the reminder finds it: by id. */
function renderInBookingForm(ui: ReactElement) {
  const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
  render(
    <form id="edit-booking-form" onSubmit={onSubmit}>
      {ui}
    </form>
  );
  return onSubmit;
}

describe("ReserveReminder — the Reserve button that stays on screen", () => {
  it("says the booking isn't held yet and submits the booking form as Reserve", async () => {
    const user = userEvent.setup();
    const onSubmit = renderInBookingForm(
      <ReserveReminder label="Reserve" disabled={false} />
    );

    expect(screen.getByText("Not reserved yet")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is held until you click Reserve.")
    ).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Reserve" });
    // The SAME form as the header button, so name, dates and "Reserved for"
    // go with it, and the same intent.
    expect(button).toHaveAttribute("form", "edit-booking-form");
    expect(button).toHaveAttribute("name", "intent");
    expect(button).toHaveAttribute("value", "reserve");

    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the header's Reserve can't be pressed either", async () => {
    const user = userEvent.setup();
    const onSubmit = renderInBookingForm(
      <ReserveReminder
        label="Request reservation"
        disabled={{ reason: "Your booking has assets that are already booked" }}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Request reservation" })
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
