import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "~/components/shared/tooltip";
import type { LoanItems } from "~/modules/big-loan-agreement/service.server";
import { LoanItemsList } from "./loan-items";

const code = (value: string) => ({
  value,
  type: "SAM_ID" as const,
  isFallback: false,
  workspacePreference: "SAM_ID" as const,
});

const ITEMS: LoanItems = {
  assets: [
    { id: "a1", title: "Canon C70", code: code("SAM-0042") },
    { id: "a2", title: "Sennheiser MKE 600", code: code("SAM-0107") },
  ],
  supplies: [
    { id: "s1", name: "AA batteries", quantity: 4, isConsumable: true },
    { id: "s2", name: "XLR cable", quantity: 2, isConsumable: false },
  ],
};

describe("LoanItemsList — equipment AND supplies, on screen and on paper", () => {
  it("lists every piece of equipment and every supply on the signing page", () => {
    // The app provides one TooltipProvider at the root; the code badge needs it.
    render(
      <TooltipProvider>
        <LoanItemsList items={ITEMS} variant="screen" />
      </TooltipProvider>
    );

    expect(screen.getByText("Equipment (2)")).toBeInTheDocument();
    expect(screen.getByText("Canon C70")).toBeInTheDocument();
    expect(screen.getByText("Sennheiser MKE 600")).toBeInTheDocument();
    expect(screen.getByText("Supplies (2)")).toBeInTheDocument();
    expect(screen.getByText(/AA batteries/)).toBeInTheDocument();
    expect(screen.getByText(/XLR cable/)).toBeInTheDocument();
    expect(screen.getByText("consumable")).toBeInTheDocument();
  });

  it("prints both as tables with codes, quantities and tick boxes", () => {
    render(<LoanItemsList items={ITEMS} variant="print" />);

    const equipment = screen.getByRole("table", { name: "Equipment (2)" });
    expect(within(equipment).getByText("Canon C70")).toBeInTheDocument();
    expect(within(equipment).getByText("SAM-0042")).toBeInTheDocument();
    expect(
      within(equipment).getByRole("columnheader", { name: "Returned" })
    ).toBeInTheDocument();

    const supplies = screen.getByRole("table", { name: "Supplies (2)" });
    const batteries = within(supplies).getByText("AA batteries").closest("tr")!;
    expect(within(batteries).getByText("4")).toBeInTheDocument();
    // Consumables are used up, so there's nothing to tick on return.
    expect(within(batteries).getByText("not returned")).toBeInTheDocument();
  });

  it("says so when a booking has nothing yet", () => {
    render(
      <LoanItemsList items={{ assets: [], supplies: [] }} variant="screen" />
    );
    expect(
      screen.getByText("No equipment on this booking.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No supplies on this booking.")
    ).toBeInTheDocument();
  });
});
