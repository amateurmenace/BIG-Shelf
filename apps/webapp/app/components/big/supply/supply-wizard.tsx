/**
 * Supply wizard
 *
 * The "grab your cables and batteries" step of building a reservation.
 *
 * Shape of the interaction: one category per step (Cables → Batteries → …),
 * each showing that category's supplies with a stepper. The basket persists
 * across steps and is posted once at the end as JSON.
 *
 * Why a wizard and not one long list: the real task is "walk the kit list in
 * your head" — two XLRs, a battery, four HDMIs — and grouping by category
 * matches how people actually remember what they need. A flat list of sixty
 * accessories does not.
 *
 * @see {@link file://./../../../modules/big-supply/service.server.ts}
 */
import { useMemo, useReducer } from "react";
import type { SupplyCategory } from "@prisma/client";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import type { SupplyWithAvailability } from "~/modules/big-supply/service.server";
import {
  MAX_SUPPLY_QUANTITY,
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_CATEGORY_ORDER,
  SUPPLY_INTENT,
} from "~/modules/big-supply/shared";
import { tw } from "~/utils/tw";

/** supplyId → quantity. */
type Basket = Record<string, number>;

type State = {
  /** Index into the wizard's category steps. */
  stepIndex: number;
  basket: Basket;
};

type Action =
  | { type: "next" }
  | { type: "back" }
  | { type: "goToStep"; index: number }
  | { type: "setQuantity"; supplyId: string; quantity: number }
  | { type: "clear" };

/**
 * All the wizard's state transitions in one place.
 *
 * `setQuantity` and step movement are coupled (moving on must not lose the
 * basket), which is exactly the case the codebase's `useReducer` rule covers.
 * @see .claude/rules/use-reducer-for-related-state.md
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "next":
      return { ...state, stepIndex: state.stepIndex + 1 };
    case "back":
      return { ...state, stepIndex: Math.max(0, state.stepIndex - 1) };
    case "goToStep":
      return { ...state, stepIndex: action.index };
    case "setQuantity": {
      const next = { ...state.basket };
      if (action.quantity <= 0) {
        delete next[action.supplyId];
      } else {
        next[action.supplyId] = Math.min(action.quantity, MAX_SUPPLY_QUANTITY);
      }
      return { ...state, basket: next };
    }
    case "clear":
      return { ...state, basket: {} };
  }
}

export function SupplyWizard({
  supplies,
  /** Where to post the basket. Defaults to the current route's action. */
  action,
  /** Called after a successful save — typically closes the drawer. */
  onSaved,
}: {
  supplies: SupplyWithAvailability[];
  action?: string;
  onSaved?: () => void;
}) {
  const fetcher = useFetcher<{ error?: { message?: string } }>();
  const disabled = useDisabled(fetcher);

  /** Only categories that actually have supplies become steps. */
  const steps = useMemo(() => {
    const byCategory = new Map<SupplyCategory, SupplyWithAvailability[]>();
    for (const supply of supplies) {
      const list = byCategory.get(supply.category) ?? [];
      list.push(supply);
      byCategory.set(supply.category, list);
    }
    return SUPPLY_CATEGORY_ORDER.filter((category) =>
      byCategory.has(category)
    ).map((category) => ({
      category,
      label: SUPPLY_CATEGORY_LABELS[category],
      supplies: byCategory.get(category) ?? [],
    }));
  }, [supplies]);

  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    stepIndex: 0,
    // Seed from what the booking already takes, so the wizard opens showing
    // the current list rather than an empty basket that would wipe it on save.
    basket: Object.fromEntries(
      supplies
        .filter((supply) => supply.quantityOnThisBooking > 0)
        .map((supply) => [supply.id, supply.quantityOnThisBooking])
    ),
  }));

  const totalUnits = Object.values(state.basket).reduce(
    (sum, quantity) => sum + quantity,
    0
  );
  const totalLines = Object.keys(state.basket).length;

  const isReviewStep = state.stepIndex >= steps.length;
  const currentStep = steps[state.stepIndex];

  const basketLines = useMemo(
    () =>
      Object.entries(state.basket)
        .map(([supplyId, quantity]) => ({
          supplyId,
          quantity,
          supply: supplies.find((item) => item.id === supplyId),
        }))
        .filter(
          (
            line
          ): line is {
            supplyId: string;
            quantity: number;
            supply: SupplyWithAvailability;
          } => Boolean(line.supply)
        ),
    [state.basket, supplies]
  );

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-25 p-6 text-center">
        <p className="text-sm font-medium text-gray-900">
          No supplies set up yet
        </p>
        <p className="mt-1 text-sm text-gray-600">
          Cables, batteries and other accessories are managed in Workspace
          settings.
        </p>
        <Button to="/settings/supplies" variant="secondary" className="mt-3">
          Manage supplies
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Step rail — also a shortcut: tap any category to jump straight to it */}
      <nav
        className="flex flex-wrap gap-2 border-b pb-3"
        aria-label="Supply categories"
      >
        {steps.map((step, index) => {
          const count = step.supplies.reduce(
            (sum, supply) => sum + (state.basket[supply.id] ?? 0),
            0
          );
          const active = index === state.stepIndex;
          return (
            <button
              key={step.category}
              type="button"
              onClick={() => dispatch({ type: "goToStep", index })}
              aria-current={active ? "step" : undefined}
              className={tw(
                "rounded-full border px-3 py-1 text-xs font-medium transition",
                active
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
              )}
            >
              {step.label}
              {count > 0 ? (
                <span className="ml-1.5 rounded-full bg-primary-600 px-1.5 text-[10px] text-white">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => dispatch({ type: "goToStep", index: steps.length })}
          aria-current={isReviewStep ? "step" : undefined}
          className={tw(
            "rounded-full border px-3 py-1 text-xs font-medium transition",
            isReviewStep
              ? "border-primary-500 bg-primary-50 text-primary-700"
              : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
          )}
        >
          Review
        </button>
      </nav>

      <div className="flex-1 overflow-y-auto py-4">
        {isReviewStep ? (
          <ReviewStep lines={basketLines} dispatch={dispatch} />
        ) : (
          <>
            <h4 className="mb-1">{currentStep.label}</h4>
            <p className="mb-4 text-sm text-gray-600">
              Set how many you need. Availability is for this booking&apos;s
              dates.
            </p>
            <ul className="divide-y divide-gray-100">
              {currentStep.supplies.map((supply) => (
                <SupplyRow
                  key={supply.id}
                  supply={supply}
                  quantity={state.basket[supply.id] ?? 0}
                  disabled={disabled}
                  onChange={(quantity) =>
                    dispatch({
                      type: "setQuantity",
                      supplyId: supply.id,
                      quantity,
                    })
                  }
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {fetcher.data?.error?.message ? (
        <p className="mb-2 rounded border border-error-200 bg-error-50 p-2 text-sm text-error-600">
          {fetcher.data.error.message}
        </p>
      ) : null}

      <footer className="flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">{totalUnits}</span>{" "}
          {totalUnits === 1 ? "item" : "items"} across{" "}
          <span className="font-semibold text-gray-900">{totalLines}</span>{" "}
          {totalLines === 1 ? "type" : "types"}
        </p>

        <div className="flex gap-2">
          {state.stepIndex > 0 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => dispatch({ type: "back" })}
            >
              Back
            </Button>
          ) : null}

          {isReviewStep ? (
            <fetcher.Form
              method="post"
              action={action}
              onSubmit={() => {
                // The save is optimistic from the drawer's point of view; the
                // action revalidates the booking page either way.
                onSaved?.();
              }}
            >
              <input
                type="hidden"
                name="intent"
                value={SUPPLY_INTENT.saveBasket}
              />
              <input
                type="hidden"
                name="supplyBasket"
                value={JSON.stringify(
                  basketLines.map((line) => ({
                    supplyId: line.supplyId,
                    quantity: line.quantity,
                  }))
                )}
              />
              <Button type="submit" disabled={disabled}>
                {disabled ? "Saving..." : "Add to booking"}
              </Button>
            </fetcher.Form>
          ) : (
            <Button
              type="button"
              disabled={disabled}
              onClick={() => dispatch({ type: "next" })}
            >
              {state.stepIndex === steps.length - 1 ? "Review" : "Next"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** One supply, with a stepper and its availability for the booking window. */
function SupplyRow({
  supply,
  quantity,
  disabled,
  onChange,
}: {
  supply: SupplyWithAvailability;
  quantity: number;
  disabled: boolean;
  onChange: (quantity: number) => void;
}) {
  const atMax = quantity >= supply.available;
  const noneFree = supply.available === 0;

  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">
          {supply.name}
          {supply.isConsumable ? (
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600">
              Consumable
            </span>
          ) : null}
        </p>
        <p className="text-xs text-gray-500">
          {noneFree ? (
            <span className="text-error-600">
              None free for these dates ({supply.quantityTotal} owned, all
              committed)
            </span>
          ) : (
            <>
              {supply.available} of {supply.quantityTotal} free
              {supply.storageLocation ? ` · ${supply.storageLocation}` : ""}
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="p-2"
          aria-label={`Remove one ${supply.name}`}
          disabled={disabled || quantity === 0}
          onClick={() => onChange(quantity - 1)}
        >
          <MinusIcon className="size-4" />
        </Button>
        <input
          type="number"
          className="w-14 rounded border border-gray-300 px-2 py-1 text-center text-sm tabular-nums"
          aria-label={`Quantity of ${supply.name}`}
          value={quantity}
          min={0}
          max={supply.available}
          disabled={disabled || noneFree}
          onChange={(event) => {
            const parsed = Number.parseInt(event.currentTarget.value, 10);
            onChange(Number.isNaN(parsed) ? 0 : parsed);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="p-2"
          aria-label={`Add one ${supply.name}`}
          disabled={disabled || atMax}
          onClick={() => onChange(quantity + 1)}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </li>
  );
}

/** The final step: everything in the basket, with a last chance to change it. */
function ReviewStep({
  lines,
  dispatch,
}: {
  lines: {
    supplyId: string;
    quantity: number;
    supply: SupplyWithAvailability;
  }[];
  dispatch: (action: Action) => void;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center">
        <p className="text-sm font-medium text-gray-900">
          Nothing selected yet
        </p>
        <p className="mt-1 text-sm text-gray-600">
          Step back through the categories to add cables, batteries and other
          accessories. Saving now clears any supplies already on this booking.
        </p>
      </div>
    );
  }

  return (
    <>
      <h4 className="mb-1">Review</h4>
      <p className="mb-4 text-sm text-gray-600">
        This replaces the supplies currently on the booking.
      </p>
      <ul className="divide-y divide-gray-100">
        {lines.map((line) => (
          <li
            key={line.supplyId}
            className="flex items-center justify-between gap-4 py-2.5"
          >
            <span className="min-w-0 truncate text-sm text-gray-900">
              <span className="font-semibold tabular-nums">
                {line.quantity} ×
              </span>{" "}
              {line.supply.name}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                dispatch({
                  type: "setQuantity",
                  supplyId: line.supplyId,
                  quantity: 0,
                })
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
