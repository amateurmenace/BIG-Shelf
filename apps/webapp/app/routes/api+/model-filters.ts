import { OrganizationRoles } from "@prisma/client";
import { TagUseFor } from "@prisma/client";
import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { searchDirectoryMembers } from "~/modules/big-member-directory/service.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { makeShelfError } from "~/utils/error";
import { payload, error, parseData } from "~/utils/http.server";

const BasicModelFilters = z.object({
  /** key of field for which we have to filter values */
  queryKey: z.string(),

  /** Actual value */
  queryValue: z.string().optional(),

  /** What user have already selected, so that we can exclude them */
  selectedValues: z.string().optional(),
});

/**
 * The schema used for each different model.
 * To allow filtersing and searching on different models update the schema for the relevant model
 */
export const ModelFiltersSchema = z.discriminatedUnion("name", [
  BasicModelFilters.extend({
    name: z.literal("asset"),
  }),
  BasicModelFilters.extend({
    name: z.literal("tag"),
    useFor: z.nativeEnum(TagUseFor).optional(),
  }),
  BasicModelFilters.extend({
    name: z.literal("category"),
  }),
  BasicModelFilters.extend({
    name: z.literal("location"),
  }),
  BasicModelFilters.extend({
    name: z.literal("kit"),
  }),
  BasicModelFilters.extend({
    name: z.literal("teamMember"),
    deletedAt: z.string().nullable().optional(),
    userWithAdminAndOwnerOnly: z.coerce.boolean().optional(), // To get only the teamMembers which are admin or owner
    usersOnly: z.coerce.boolean().optional(), // To get only the teamMembers with users (exclude NRMs)
    /**
     * BIG: also search the Neon member directory, so staff can reserve for a
     * member who has never logged in and therefore has no TeamMember row.
     * Opt-in, so every other team-member picker is unaffected.
     * @see ~/modules/big-member-directory/service.server.ts
     */
    includeDirectory: z.coerce.boolean().optional(),
  }),
  BasicModelFilters.extend({
    name: z.literal("booking"),
  }),
]);

export type AllowedModelNames = z.infer<typeof ModelFiltersSchema>["name"];
export type ModelFilters = z.infer<typeof ModelFiltersSchema>;
export type ModelFiltersLoader = typeof loader;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, userOrganizations } = await getSelectedOrganization(
      {
        userId,
        request,
      }
    );

    /**
     * BIG: only staff may search the member directory.
     *
     * This endpoint authenticates but does not authorize beyond org
     * membership, so without this check ANY signed-in member could pass
     * `includeDirectory=true` and enumerate every BIG member's name and email
     * address. The member portal is deliberately anonymised — members see
     * that a room is taken, never by whom — and a full membership list with
     * contact details is exactly the kind of thing it exists to withhold.
     */
    const callerRoles =
      userOrganizations?.find((org) => org.organizationId === organizationId)
        ?.roles ?? [];
    const callerIsStaff =
      callerRoles.includes(OrganizationRoles.ADMIN) ||
      callerRoles.includes(OrganizationRoles.OWNER);

    /** Getting all the query parameters from url */
    const url = new URL(request.url);
    const searchParams: Record<string, any> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (value === "null") {
        searchParams[key] = null;
      } else {
        searchParams[key] = value;
      }
    }

    /** Validating parameters */
    const modelFilters = parseData(searchParams, ModelFiltersSchema);
    const { name, queryKey, queryValue, selectedValues } = modelFilters;

    const where: Record<string, any> = {
      organizationId,
      OR: [{ id: { in: (selectedValues ?? "").split(",") } }],
    };
    /**
     * When searching for teamMember, we have to search for
     * - teamMember's name
     * - teamMember's user firstName, lastName and email
     */
    if (modelFilters.name === "teamMember") {
      where.OR.push(
        { name: { contains: queryValue, mode: "insensitive" } },
        { user: { firstName: { contains: queryValue, mode: "insensitive" } } },
        // BIG: this line read `firstName` twice, so a search by surname never
        // matched a registered user — the comment above always claimed it did.
        { user: { lastName: { contains: queryValue, mode: "insensitive" } } },
        { user: { email: { contains: queryValue, mode: "insensitive" } } }
      );

      where.deletedAt = modelFilters.deletedAt;
      if (modelFilters.userWithAdminAndOwnerOnly) {
        where.AND = [
          { user: { isNot: null } },
          {
            user: {
              userOrganizations: {
                some: {
                  AND: [
                    { organizationId },
                    { roles: { hasSome: ["ADMIN", "OWNER"] } },
                  ],
                },
              },
            },
          },
        ];
      } else if (modelFilters.usersOnly) {
        // Filter to show only team members with users (exclude NRMs)
        where.user = { isNot: null };
      }
    } else {
      where.OR.push({
        [queryKey]: { contains: queryValue, mode: "insensitive" },
      });
    }

    if (modelFilters.name === "booking") {
      where.status = { in: ["RESERVED", "ONGOING", "OVERDUE"] };
    }

    if (modelFilters.name === "tag" && modelFilters.useFor) {
      // Tags with "All" selected are stored with an empty useFor array, so filtering only by `has`
      // would hide those tags in bulk/tag pickers even though they are intended to be available.
      // This keeps tag searches consistent with create/edit flows that also include "All" tags.
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { useFor: { isEmpty: true } },
            { useFor: { has: modelFilters.useFor } },
          ],
        },
      ];
    }

    const queryData = (await db[name].dynamicFindMany({
      where,
      include:
        /** We need user's information to resolve teamMember's name */
        name === "teamMember"
          ? {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  displayName: true,
                  email: true,
                },
              },
            }
          : undefined,
    })) as Array<Record<string, string>>;

    const filters = queryData.map((item) => ({
      id: item.id,
      name: item[queryKey],
      color: item?.color,
      metadata: item,
      user: item?.user as any,
    }));

    /**
     * BIG: append members who exist in Neon but have no TeamMember row yet, so
     * staff can reserve for the whole membership rather than only the people
     * who have logged in. Appended AFTER the real rows so existing records win
     * the top of the list, and only when the caller opted in.
     */
    if (
      modelFilters.name === "teamMember" &&
      modelFilters.includeDirectory &&
      callerIsStaff
    ) {
      const directory = await searchDirectoryMembers({
        organizationId,
        query: queryValue,
      });

      for (const person of directory) {
        filters.push({
          id: person.id,
          name: person.name,
          // Matches the inferred shape of the rows above (no colour on a
          // team member), so the array stays a single type.
          color: undefined as unknown as string,
          // Shaped like a TeamMember row so the picker's renderer, which reads
          // `metadata.email`, needs no special case.
          metadata: { id: person.id, name: person.name, email: person.email },
          user: null as any,
        });
      }
    }

    return data(payload({ filters }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
