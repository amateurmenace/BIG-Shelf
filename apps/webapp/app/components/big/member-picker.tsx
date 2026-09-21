/**
 * Searchable member picker
 *
 * BIG: a "Reserve for" control that can search the WHOLE membership — both
 * people with a Shelf record and the ~113 members who exist only in the Neon
 * directory and have never logged in.
 *
 * Why not `DynamicSelect`: that component reads its first page and total count
 * out of `useLoaderData()` under agreed key names, which every route using it
 * must supply. This one is self-contained — it asks the filters endpoint
 * directly — so it can drop into any form, including the room booking page
 * whose loader has its own shape.
 *
 * The chosen person is written into a hidden `custodian` input in the exact
 * JSON shape `BookingFormSchema` already parses, so no server code changes to
 * accept it. A Neon-only person carries a `neon:` id that the server
 * materialises into a real record on submit.
 *
 * @see {@link file://./../../modules/big-member-directory/service.server.ts}
 * @see {@link file://./../../routes/api+/model-filters.ts}
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, SearchIcon, XIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { Spinner } from "~/components/shared/spinner";
import { tw } from "~/utils/tw";

/** How long to wait after a keystroke before querying. */
const SEARCH_DEBOUNCE_MS = 250;

/** One selectable person. */
export type MemberOption = {
  /** A TeamMember id, or `neon:<allowlistId>` for a directory-only member. */
  id: string;
  name: string;
  /** Null for a non-registered member with no account. */
  userId: string | null;
  email?: string | null;
};

/** The filters endpoint's row shape, narrowed to what this picker reads. */
type FilterRow = {
  id: string;
  name: string;
  user?: { id?: string | null; email?: string | null } | null;
  metadata?: { email?: string | null } | null;
};

export function MemberPicker({
  /** Pre-selected person, e.g. the booking's current custodian. */
  defaultValue,
  /** Form field name. Defaults to the `custodian` field the schemas expect. */
  name = "custodian",
  disabled = false,
  error,
  label = "Reserve for",
  /** Shown under the control. */
  hint,
}: {
  defaultValue?: MemberOption | null;
  name?: string;
  disabled?: boolean;
  error?: string;
  label?: string;
  hint?: string;
}) {
  const fetcher = useFetcher<{ filters?: FilterRow[] }>();
  const [selected, setSelected] = useState<MemberOption | null>(
    defaultValue ?? null
  );
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounce so typing a name does not fire a request per keystroke.
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        name: "teamMember",
        queryKey: "name",
        deletedAt: "null",
        includeDirectory: "true",
        queryValue: query,
      });
      void fetcher.load(`/api/model-filters?${params.toString()}`);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `fetcher` is intentionally omitted: it is a new object each render and
    // including it would re-fire the search on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isOpen]);

  // Close when clicking outside.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isOpen]);

  const options: MemberOption[] = useMemo(
    () =>
      (fetcher.data?.filters ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        userId: row.user?.id ?? null,
        email: row.user?.email ?? row.metadata?.email ?? null,
      })),
    [fetcher.data]
  );

  const isSearching = fetcher.state !== "idle";

  return (
    <div ref={containerRef} className="relative">
      <span className="mb-[6px] block text-sm font-medium text-gray-700">
        {label}
      </span>

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

      {selected && !isOpen ? (
        <div
          className={tw(
            "flex items-center justify-between gap-2 rounded border border-gray-300 px-3 py-2",
            disabled && "opacity-50"
          )}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm text-gray-900">
              {selected.name}
            </span>
            {selected.email ? (
              <span className="block truncate text-xs text-gray-500">
                {selected.email}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setQuery("");
              setIsOpen(true);
            }}
            className="shrink-0 rounded px-2 py-1 text-xs font-medium text-primary-700 hover:bg-primary-50"
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
            type="text"
            value={query}
            disabled={disabled}
            autoComplete="off"
            placeholder="Search members by name or email"
            aria-label={label}
            // Declares the combobox role explicitly: a bare input is a
            // textbox, and a textbox does not accept aria-expanded.
            role="combobox"
            aria-expanded={isOpen}
            aria-controls="member-picker-listbox"
            onFocus={() => setIsOpen(true)}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setIsOpen(true);
            }}
            className="w-full rounded border border-gray-300 py-2 pl-9 pr-8 text-sm text-gray-900 focus:border-primary-300 focus:outline-none focus:ring-1 focus:ring-primary-300"
          />
          {isSearching ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner className="size-4" />
            </span>
          ) : selected ? (
            <button
              type="button"
              aria-label="Clear selection"
              onClick={() => {
                setIsOpen(false);
                setQuery("");
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>
      )}

      {isOpen ? (
        <ul
          id="member-picker-listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          role="listbox"
        >
          {options.length === 0 ? (
            <li className="p-3 text-sm text-gray-500">
              {isSearching
                ? "Searching…"
                : query
                ? "No member matches that name or email."
                : "Start typing to search members."}
            </li>
          ) : (
            options.map((option) => {
              const isSelected = option.id === selected?.id;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      setSelected(option);
                      setIsOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">
                        {option.name}
                      </span>
                      {option.email ? (
                        <span className="block truncate text-xs text-gray-500">
                          {option.email}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <CheckIcon
                        className="size-4 shrink-0 text-primary-600"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}

      {hint ? <p className="mt-2 text-[14px] text-gray-600">{hint}</p> : null}
      {error ? <p className="mt-1 text-sm text-error-500">{error}</p> : null}
    </div>
  );
}
