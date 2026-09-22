import type { FormEvent } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReservablePerson } from "~/modules/big-member-directory/shared";
import { MemberPicker } from "./member-picker";

const fetcherMock = vi.hoisted(() => ({
  current: {
    load: vi.fn(),
    state: "idle" as const,
    data: undefined as unknown,
  },
}));

// why: the picker's only I/O is one fetcher load of /api/big-reservable-people;
// controlling what that returns lets these tests exercise the list and search.
vi.mock("react-router", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual("react-router");
  return { ...actual, useFetcher: () => fetcherMock.current };
});

/** Staff, a member with an account, and two people who never logged in. */
const PEOPLE: ReservablePerson[] = [
  {
    id: "neon:ava@example.com",
    name: "Ava Whitfield",
    email: "ava@example.com",
    userId: null,
    hasAccount: false,
  },
  {
    id: "neon:bea.jansen@example.com",
    name: "bea JANSEN",
    email: "bea.jansen@example.com",
    userId: null,
    hasAccount: false,
  },
  {
    id: "tm-dee",
    name: "Dee Admin",
    email: "dee@example.org",
    userId: "u-dee",
    hasAccount: true,
  },
  {
    id: "tm-sam",
    name: "Sam Tester",
    email: "sam.tester@example.com",
    userId: "u-sam",
    hasAccount: true,
  },
];

function loaded(people: ReservablePerson[] = PEOPLE) {
  fetcherMock.current = {
    load: vi.fn(),
    state: "idle",
    data: { error: null, people },
  };
}

/** The value the booking form actually submits. */
function submittedCustodian() {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="custodian"]'
  );
  return input?.value ? JSON.parse(input.value) : null;
}

beforeEach(() => {
  fetcherMock.current = {
    load: vi.fn(),
    state: "idle",
    data: undefined,
  };
});

describe("MemberPicker", () => {
  it("loads the whole list from the directory endpoint the first time it opens", async () => {
    const user = userEvent.setup();
    render(<MemberPicker />);

    expect(fetcherMock.current.load).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox"));

    expect(fetcherMock.current.load).toHaveBeenCalledWith(
      "/api/big-reservable-people"
    );
    expect(screen.getByText("Loading everyone…")).toBeInTheDocument();
  });

  it("lists EVERYONE before anything is typed — including people who never logged in", async () => {
    loaded();
    const user = userEvent.setup();
    render(<MemberPicker />);

    await user.click(screen.getByRole("combobox"));

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Ava Whitfieldava@example.com · no account yet",
      "bea JANSENbea.jansen@example.com · no account yet",
      "Dee Admindee@example.org",
      "Sam Testersam.tester@example.com",
    ]);
    expect(screen.getByText("Everyone — 4 people")).toBeInTheDocument();
  });

  it("searches by surname and by email", async () => {
    loaded();
    const user = userEvent.setup();
    render(<MemberPicker />);
    const input = screen.getByRole("combobox");

    await user.type(input, "jansen");
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["bea JANSENbea.jansen@example.com · no account yet"]);
    expect(screen.getByText("1 of 4 people match")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "sam.tester");
    expect(
      within(screen.getByRole("listbox")).getByRole("option")
    ).toHaveTextContent("Sam Tester");
  });

  it("submits a directory member's neon: id when picked with a click", async () => {
    loaded();
    const user = userEvent.setup();
    render(<MemberPicker />);

    await user.type(screen.getByRole("combobox"), "ava");
    await user.click(screen.getByRole("option", { name: /Ava Whitfield/ }));

    expect(submittedCustodian()).toEqual({
      id: "neon:ava@example.com",
      name: "Ava Whitfield",
      userId: null,
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText("Ava Whitfield")).toBeInTheDocument();
  });

  it("can be driven entirely from the keyboard", async () => {
    loaded();
    const user = userEvent.setup();
    render(<MemberPicker />);

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    // Third person: Ava → bea → Dee.
    expect(submittedCustodian()).toEqual({
      id: "tm-dee",
      name: "Dee Admin",
      userId: "u-dee",
    });
  });

  it("does not let Enter in the search box submit the booking form", async () => {
    loaded();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={onSubmit}>
        <MemberPicker />
      </form>
    );

    await user.type(screen.getByRole("combobox"), "zzz{Enter}");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Nobody matches/)).toBeInTheDocument();
  });

  it("shows the booking's current person, and lets staff change it", async () => {
    loaded();
    const user = userEvent.setup();
    render(
      <MemberPicker
        defaultValue={{ id: "tm-sam", name: "Sam Tester", userId: "u-sam" }}
      />
    );

    expect(submittedCustodian()).toEqual({
      id: "tm-sam",
      name: "Sam Tester",
      userId: "u-sam",
    });

    await user.click(screen.getByRole("button", { name: /Change who this/ }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("says why when the list cannot load", async () => {
    fetcherMock.current = {
      load: vi.fn(),
      state: "idle",
      data: { error: { message: "Only staff can reserve for other people." } },
    };
    const user = userEvent.setup();
    render(<MemberPicker />);

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByText(/Only staff can reserve for other people\./)
    ).toBeInTheDocument();
  });
});
