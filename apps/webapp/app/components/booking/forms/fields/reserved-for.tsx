/**
 * "Reserved for" field
 *
 * BIG: replaces upstream's bare "Custodian" picker on the booking forms.
 *
 * "Custodian" is warehouse vocabulary that meant nothing to the people using
 * this — staff read it as "who is looking after the shelf" rather than "whose
 * reservation is this". The concept is unchanged underneath (it still writes
 * `custodian`, the same field the server has always parsed); what changes is
 * that the common case — *I* am booking this for *myself* — is one click, and
 * booking for someone else is an explicit, obvious choice.
 *
 * When "Someone else" is chosen, the reservation is made in that person's name
 * and they are emailed to confirm it.
 * @see {@link file://./../../../../modules/big-booking-acceptance/service.server.ts}
 */
import { useState } from "react";
import DynamicSelect from "~/components/dynamic-select/dynamic-select";
import FormRow from "~/components/forms/form-row";
import { Card } from "~/components/shared/card";
import type { ModelFilterItem } from "~/hooks/use-model-filters";
import { RESERVED_FOR } from "~/modules/big-booking-acceptance/shared";
import { tw } from "~/utils/tw";
import { resolveTeamMemberName } from "~/utils/user";
import type { TeamMemberType } from "./custodian";

/**
 * Serialises a team member into the JSON blob the `custodian` form field
 * expects — the exact shape `BookingFormSchema`'s `custodian` parser reads, so
 * the server code path is unchanged.
 */
function serializeTeamMember(member: TeamMemberType) {
  return JSON.stringify({
    id: member.id,
    // If there is a linked user we show their name, otherwise the team
    // member's own name (non-registered members).
    name: resolveTeamMemberName(member),
    userId: member.userId,
  });
}

export function ReservedForField({
  /** The current user's own team-member record, used by the "Myself" choice. */
  ownTeamMember,
  /** Pre-selected team member (editing an existing booking). */
  defaultTeamMember,
  disabled,
  userCanSeeCustodian,
  isNewBooking,
  error,
  /**
   * Base/self-service users can only book for themselves, so the choice is
   * hidden entirely and the hidden `custodian` input carries their own record.
   */
  lockedToSelf = false,
}: {
  ownTeamMember?: TeamMemberType;
  defaultTeamMember: TeamMemberType | undefined;
  disabled: boolean;
  userCanSeeCustodian: boolean;
  isNewBooking?: boolean;
  error?: string;
  lockedToSelf?: boolean;
}) {
  /**
   * Which choice is active. Defaults to "myself" on a new booking when we know
   * the user's own team-member record, and otherwise to "someone else" so an
   * existing booking with another person on it opens showing that person.
   */
  const startsAsSelf =
    Boolean(ownTeamMember) &&
    (defaultTeamMember ? defaultTeamMember.id === ownTeamMember?.id : true);
  const [choice, setChoice] = useState(
    startsAsSelf ? RESERVED_FOR.myself : RESERVED_FOR.someoneElse
  );

  const isSelf = choice === RESERVED_FOR.myself;

  if (lockedToSelf) {
    return (
      <FormRow
        rowLabel="Reserved for"
        className="mobile-styling-only border-b-0 p-0"
      >
        <span className="mb-2.5 block font-medium text-gray-700">
          Reserved for
        </span>
        <p className="text-[14px] text-gray-600">
          This reservation will be in your name.
        </p>
        {defaultTeamMember ? (
          <input
            type="hidden"
            name="custodian"
            value={serializeTeamMember(defaultTeamMember)}
          />
        ) : null}
        {error ? <div className="text-sm text-error-500">{error}</div> : null}
      </FormRow>
    );
  }

  return (
    <FormRow
      rowLabel="Reserved for"
      className="mobile-styling-only border-b-0 p-0"
    >
      <span
        className="mb-2.5 block font-medium text-gray-700"
        id="reserved-for-label"
      >
        <span className="required-input-label">Reserved for</span>
      </span>

      {/* Two-way choice. A radiogroup rather than a select: there are exactly
          two options and the second one reveals a picker. */}
      <div
        className="mb-3 flex gap-2"
        role="radiogroup"
        aria-labelledby="reserved-for-label"
      >
        {[
          { value: RESERVED_FOR.myself, label: "Myself" },
          { value: RESERVED_FOR.someoneElse, label: "Someone else" },
        ].map((option) => {
          const active = choice === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={
                disabled ||
                (option.value === RESERVED_FOR.myself && !ownTeamMember)
              }
              onClick={() => setChoice(option.value)}
              className={tw(
                "flex-1 rounded-md border px-3 py-2 text-sm font-medium transition",
                "disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {isSelf && ownTeamMember ? (
        <>
          <input
            type="hidden"
            name="custodian"
            value={serializeTeamMember(ownTeamMember)}
          />
          <p className="text-[14px] text-gray-600">
            This reservation will be in your name — you are responsible for the
            equipment for the booking period.
          </p>
        </>
      ) : (
        <>
          <DynamicSelect
            key="reserved-for-picker"
            defaultValue={
              defaultTeamMember && defaultTeamMember.id !== ownTeamMember?.id
                ? serializeTeamMember(defaultTeamMember)
                : undefined
            }
            disabled={disabled}
            model={{
              name: "teamMember",
              queryKey: "name",
              deletedAt: null,
              /**
               * BIG: search the whole Neon membership, not just people who
               * have a Shelf record. Most members have never logged in, so
               * without this the picker offers staff and almost nobody else.
               * @see ~/modules/big-member-directory/service.server.ts
               */
              includeDirectory: true,
            }}
            fieldName="custodian"
            contentLabel="Team members"
            initialDataKey="teamMembersForForm"
            countKey="totalTeamMembers"
            placeholder="Search members by name or email"
            allowClear
            closeOnSelect
            transformItem={(item: ModelFilterItem & { userId?: string }) => ({
              ...item,
              id: JSON.stringify({
                id: item.id,
                // If there is a user, we use its name, otherwise the team
                // member's own name (non-registered members).
                name: resolveTeamMemberName(item),
                userId: item?.userId,
              }),
            })}
            renderItem={(item) => {
              if (!userCanSeeCustodian && !isNewBooking) return "Private";

              const email = (item as { metadata?: { email?: string } })
                ?.metadata?.email;

              return (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {resolveTeamMemberName(item, true)}
                  </span>
                  {email ? (
                    <span className="truncate text-xs text-gray-500">
                      {email}
                    </span>
                  ) : null}
                </span>
              );
            }}
          />
          <p className="mt-2 text-[14px] text-gray-600">
            Search any BIG member by name or email — they do not need to have
            logged in before. The reservation goes in their name and they are
            emailed to confirm it; the equipment is held for them straight away.
          </p>
        </>
      )}

      {error ? <div className="text-sm text-error-500">{error}</div> : null}
    </FormRow>
  );
}

/** Convenience wrapper so callers keep the same `<Card>` shell as before. */
export function ReservedForCard(props: Parameters<typeof ReservedForField>[0]) {
  return (
    <Card className="field-card m-0">
      <ReservedForField {...props} />
    </Card>
  );
}
