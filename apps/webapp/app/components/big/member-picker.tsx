/**
 * Searchable member picker
 *
 * BIG: the "Reserved for" control on every staff reservation surface — new
 * booking, booking edit, the assets-index "create booking" dialog, and the
 * staff room form. It offers EVERYONE: staff, members with accounts, and the
 * Neon members who have never logged in.
 *
 * How it gets that list: on first open it loads the complete population once
 * from `/api/big-reservable-people` and searches it in the browser. An earlier
 * version paged through the shared filters endpoint and only asked the server
 * when it thought its first page was incomplete — so as soon as every team
 * member fitted on one page it stopped asking, and the Neon directory never
 * appeared. Loading everyone (a few hundred rows at most) removes that whole
 * class of bug, and makes search instant.
 *
 * The chosen person is written into a hidden `custodian` input in the JSON
 * shape `BookingFormSchema` already parses. A Neon-only person carries a
 * `neon:<email>` id; the server creates their record on submit.
 *
 * Keyboard: ↑/↓ move, Enter picks, Escape closes (WAI-ARIA combobox pattern).
 *
 * @see {@link file://./../../routes/api+/big-reservable-people.ts}
 * @see {@link file://./../../modules/big-member-directory/service.server.ts}
 */
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useReducer, useRef } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { Spinner } from "~/components/shared/spinner";
import type { ReservablePerson } from "~/modules/big-member-directory/shared";
import { filterReservablePeople } from "~/modules/big-member-directory/shared";
import type { loader as reservablePeopleLoader } from "~/routes/api+/big-reservable-people";
import { tw } from "~/utils/tw";

/** The person currently chosen — possibly one not in the loaded list yet. */
export type MemberOption = Pick<ReservablePerson, "id" | "name" | "userId"> &
  Partial<Pick<ReservablePerson, "email" | "hasAccount">>;

type State = {
  isOpen: boolean;
  query: string;
  /** Index into the FILTERED list of the keyboard-highlighted option. */
  activeIndex: number;
  selected: MemberOption | null;
};

type Action =
  | { type: "open" }
  | { type: "close" }
  | { type: "type"; query: string }
  | { type: "move"; delta: 1 | -1; count: number }
  | { type: "pick"; person: MemberOption };

/** Opening, typing, moving and picking change several fields at once. */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return { ...state, isOpen: true, query: "", activeIndex: 0 };
    case "close":
      return { ...state, isOpen: false, query: "" };
    case "type":
      // A new query means a new list: highlight its first match.
      return { ...state, isOpen: true, query: action.query, activeIndex: 0 };
    case "move": {
      if (action.count === 0) return state;
      const next =
        (state.activeIndex + action.delta + action.count) % action.count;
      return { ...state, activeIndex: next };
    }
    case "pick":
      return {
        isOpen: false,
        query: "",
        activeIndex: 0,
        selected: action.person,
      };
  }
}

/**
 * @param props.defaultValue - Pre-selected person, e.g. the booking's current
 *   custodian.
 * @param props.name - Form field name. Defaults to the `custodian` field the
 *   booking schemas parse.
 * @param props.disabled - Disables the control (e.g. while submitting).
 * @param props.error - Server-side validation message to show under it.
 * @param props.label - Visible label. Pass `null` when the surrounding form row
 *   already shows one; the input keeps an accessible (screen-reader) label.
 * @param props.hint - Help text under the control.
 */
export function MemberPicker({
  defaultValue,
  name = "custodian",
  disabled = false,
  error,
  label = "Reserve for",
  hint,
}: {
  defaultValue?: MemberOption | null;
  name?: string;
  disabled?: boolean;
  error?: string;
  label?: string | null;
  hint?: string;
}) {
  const fetcher = useFetcher<typeof reservablePeopleLoader>();
  const [state, dispatch] = useReducer(reducer, {
    isOpen: false,
    query: "",
    activeIndex: 0,
    selected: defaultValue ?? null,
  });
  const { isOpen, query, activeIndex, selected } = state;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = {
    input: useId(),
    listbox: useId(),
    hint: useId(),
    error: useId(),
  };
  const optionId = (index: number) => `${ids.listbox}-option-${index}`;

  const loadError =
    fetcher.data && "error" in fetcher.data && fetcher.data.error
      ? fetcher.data.error.message
      : null;
  const people: ReservablePerson[] | null =
    fetcher.data && "people" in fetcher.data ? fetcher.data.people : null;

  // Load the whole list the first time the picker is opened, once.
  useEffect(() => {
    if (isOpen && fetcher.state === "idle" && !fetcher.data) {
      void fetcher.load("/api/big-reservable-people");
    }
    // `fetcher` is a new object every render; depending on it would re-run
    // this on every parent re-render. `fetcher.data` guards against reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, fetcher.state, fetcher.data]);

  const matches = useMemo(
    () => (people ? filterReservablePeople(people, query) : []),
    [people, query]
  );

  // Keep the highlighted option visible while arrowing through a long list.
  useEffect(() => {
    if (!isOpen) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, isOpen]);

  // Close when clicking outside.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        dispatch({ type: "close" });
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isOpen]);

  function pick(person: MemberOption) {
    dispatch({ type: "pick", person });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          dispatch({ type: "open" });
          return;
        }
        dispatch({
          type: "move",
          delta: event.key === "ArrowDown" ? 1 : -1,
          count: matches.length,
        });
        return;
      case "Enter":
        // Never let Enter submit the surrounding booking form from here.
        event.preventDefault();
        if (isOpen && matches[activeIndex]) pick(matches[activeIndex]);
        return;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          dispatch({ type: "close" });
        }
        return;
    }
  }

  const isLoading = isOpen && !people && !loadError;
  const showSummary = selected && !isOpen;
  const describedBy =
    [hint ? ids.hint : null, error ? ids.error : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div ref={containerRef} className="relative">
      <label
        htmlFor={ids.input}
        className={
          label ? "mb-[6px] block text-sm font-medium text-gray-700" : "sr-only"
        }
      >
        {label || "Reserved for"}
      </label>

      {/* The value the form actually submits. */}
      <input
        type="hidden"
        name={name}
        value={
          selected
            ? JSON.stringify({
                id: selected.id,
                name: selected.name,
                userId: selected.userId,
              })
            : ""
        }
      />

      {showSummary ? (
        <div
          className={tw(
            "flex items-center justify-between gap-2 rounded border border-gray-300 px-3 py-2",
            disabled && "opacity-50"
          )}
        >
          <PersonLabel person={selected} />
          <button
            type="button"
            disabled={disabled}
            aria-label={`Change who this is reserved for (currently ${selected.name})`}
            onClick={() => {
              dispatch({ type: "open" });
              // The input only mounts once open; focus it on the next frame.
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="shrink-0 rounded px-2 py-1 text-sm font-medium text-primary-700 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
            aria-hidden
          />
          <input
            ref={inputRef}
            id={ids.input}
            type="text"
            role="combobox"
            value={query}
            disabled={disabled}
            autoComplete="off"
            placeholder="Search everyone by name or email"
            aria-expanded={isOpen}
            aria-controls={ids.listbox}
            aria-autocomplete="list"
            aria-activedescendant={
              isOpen && matches[activeIndex] ? optionId(activeIndex) : undefined
            }
            aria-describedby={describedBy}
            onFocus={() => {
              if (!isOpen) dispatch({ type: "open" });
            }}
            onChange={(event) =>
              dispatch({ type: "type", query: event.currentTarget.value })
            }
            onKeyDown={onKeyDown}
            className="w-full rounded border border-gray-300 px-9 py-2 text-sm text-gray-900 focus:border-primary-300 focus:outline-none focus:ring-1 focus:ring-primary-300"
          />
          {isLoading ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner className="size-4" />
            </span>
          ) : null}
        </div>
      )}

      {isOpen ? (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
          {people ? (
            // Reassures staff the whole membership is here, not a first page.
            <p
              className="border-b border-gray-100 px-3 py-1.5 text-xs text-gray-600"
              aria-live="polite"
            >
              {query
                ? `${matches.length} of ${people.length} people match`
                : `Everyone — ${people.length} people`}
            </p>
          ) : null}
          <ul
            id={ids.listbox}
            role="listbox"
            aria-label="People you can reserve for"
            className="max-h-72 overflow-y-auto py-1"
          >
            {loadError ? (
              <li className="p-3 text-sm text-error-500">
                Could not load the member list: {loadError}
              </li>
            ) : isLoading ? (
              <li className="p-3 text-sm text-gray-500">Loading everyone…</li>
            ) : matches.length === 0 ? (
              <li className="p-3 text-sm text-gray-500">
                Nobody matches “{query}”. Try part of a first name, surname or
                email.
              </li>
            ) : (
              matches.map((person, index) => {
                const isSelected = person.id === selected?.id;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={person.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    // Mouse users pick with a click; keyboard users with Enter
                    // on the input (focus never leaves it — combobox pattern).
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(person);
                    }}
                    className={tw(
                      "flex cursor-pointer items-center justify-between gap-2 px-3 py-2",
                      isActive ? "bg-primary-50" : "hover:bg-gray-50"
                    )}
                  >
                    <PersonLabel person={person} />
                    {isSelected ? (
                      <CheckIcon
                        className="size-4 shrink-0 text-primary-600"
                        aria-hidden
                      />
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}

      {hint ? (
        <p id={ids.hint} className="mt-2 text-sm text-gray-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="mt-1 text-sm text-error-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Name over email, plus a note when the person has no account. */
function PersonLabel({ person }: { person: MemberOption }) {
  const details = [
    person.email,
    person.hasAccount === false ? "no account yet" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="min-w-0">
      <span className="block truncate text-sm text-gray-900">
        {person.name}
      </span>
      {details ? (
        // gray-600 rather than gray-500: this is small text, so keep contrast
        // comfortably clear of the WCAG AA minimum.
        <span className="block truncate text-xs text-gray-600">{details}</span>
      ) : null}
    </span>
  );
}
