/**
 * Workspace settings → Supplies
 *
 * Where staff define the pooled consumables and accessories that reservations
 * draw on: cables, batteries, adapters, media, gaff tape.
 *
 * A supply is a TYPE with a quantity, not an individually tracked asset. There
 * is one row for "25ft XLR cable" with `quantityTotal: 18`, not eighteen rows
 * with eighteen QR labels.
 *
 * Gated on `generalSettings` like the other workspace-level settings screens.
 *
 * @see {@link file://./../../modules/big-supply/service.server.ts}
 * @see {@link file://./../../components/big/supply/supply-wizard.tsx}
 */
import { useState } from "react";
import { SupplyCategory } from "@prisma/client";
import { PencilIcon } from "lucide-react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import { Form } from "~/components/custom-form";
import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { useDisabled } from "~/hooks/use-disabled";
import {
  createSupply,
  getSuppliesWithAvailability,
  setSupplyActive,
  updateSupply,
} from "~/modules/big-supply/service.server";
import {
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_CATEGORY_ORDER,
  SupplyFormSchema,
} from "~/modules/big-supply/shared";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

export const meta = () => [{ title: appendToMetaTitle("Supplies") }];

export const handle = { name: "settings.supplies" };

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });

    // No window: availability here means "committed right now", which is the
    // useful signal when deciding whether to buy more.
    const supplies = await getSuppliesWithAvailability({
      organizationId,
      includeInactive: true,
    });

    return payload({
      header: {
        title: "Supplies",
        subHeading:
          "Cables, batteries, adapters and other accessories that are counted rather than individually tracked.",
      },
      supplies,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/** Action intents for this screen. */
const IntentSchema = z.object({
  intent: z.enum(["create", "update", "retire", "restore"]),
  supplyId: z.string().optional(),
});

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const { intent, supplyId } = parseData(formData, IntentSchema, {
      additionalData: { userId, organizationId },
    });

    switch (intent) {
      case "create": {
        const input = parseData(formData, SupplyFormSchema, {
          additionalData: { userId, organizationId },
          shouldBeCaptured: false,
        });
        await createSupply({ organizationId, userId, input });
        return payload({ success: true });
      }

      case "update": {
        const input = parseData(formData, SupplyFormSchema, {
          additionalData: { userId, organizationId },
          shouldBeCaptured: false,
        });
        // `supplyId` comes from the form; `updateSupply` proves it belongs to
        // this organization before writing.
        await updateSupply({
          supplyId: supplyId ?? "",
          organizationId,
          input,
        });
        return payload({ success: true });
      }

      case "retire":
      case "restore": {
        await setSupplyActive({
          supplyId: supplyId ?? "",
          organizationId,
          active: intent === "restore",
        });
        return payload({ success: true });
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function SuppliesSettings() {
  const { supplies } = useLoaderData<typeof loader>();
  const [editingId, setEditingId] = useState<string | null>(null);

  const active = supplies.filter((supply) => supply.available >= 0);
  const grouped = SUPPLY_CATEGORY_ORDER.map((category) => ({
    category,
    label: SUPPLY_CATEGORY_LABELS[category],
    items: active.filter((supply) => supply.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row">
      <div className="lg:w-1/3">
        <Card className="my-0">
          <h3 className="mb-1 text-text-lg font-semibold">Add a supply</h3>
          <p className="mb-4 text-sm text-gray-600">
            Give it the name people say out loud — &ldquo;25ft XLR cable&rdquo;,
            &ldquo;Canon LP-E6 battery&rdquo; — and how many you own.
          </p>
          <SupplyForm key={supplies.length} intent="create" />
        </Card>
      </div>

      <div className="flex-1">
        {grouped.length === 0 ? (
          <Card className="my-0 text-center">
            <p className="text-sm font-medium text-gray-900">No supplies yet</p>
            <p className="mt-1 text-sm text-gray-600">
              Add your first one on the left. They will then appear in the
              &ldquo;Add supplies&rdquo; wizard on every booking.
            </p>
          </Card>
        ) : (
          grouped.map((group) => (
            <Card key={group.category} className="my-0 mb-4 p-0">
              <div className="border-b border-gray-100 px-4 py-3 md:px-6">
                <h3 className="text-sm font-semibold text-gray-900">
                  {group.label}
                </h3>
              </div>
              <ul className="divide-y divide-gray-100">
                {group.items.map((supply) => (
                  <li key={supply.id} className="px-4 py-3 md:px-6">
                    {editingId === supply.id ? (
                      <div>
                        <SupplyForm
                          intent="update"
                          supply={supply}
                          onDone={() => setEditingId(null)}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p
                            className={tw(
                              "truncate text-sm font-medium",
                              supply.available === 0
                                ? "text-gray-500"
                                : "text-gray-900"
                            )}
                          >
                            {supply.name}
                            {supply.isConsumable ? (
                              <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600">
                                Consumable
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-gray-500">
                            <span className="tabular-nums">
                              {supply.available}
                            </span>{" "}
                            of{" "}
                            <span className="tabular-nums">
                              {supply.quantityTotal}
                            </span>{" "}
                            free right now
                            {supply.storageLocation
                              ? ` · ${supply.storageLocation}`
                              : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* Utilisation bar: brand colour, width carries the
                              magnitude — no good/bad thresholds.
                              @see .claude/rules/reports-styling.md */}
                          <div className="hidden h-2 w-20 overflow-hidden rounded-full bg-gray-200 md:block">
                            <div
                              className="h-full rounded-full bg-primary-500"
                              style={{
                                width: `${
                                  supply.quantityTotal > 0
                                    ? Math.round(
                                        (supply.reservedElsewhere /
                                          supply.quantityTotal) *
                                          100
                                      )
                                    : 0
                                }%`,
                              }}
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="p-2"
                            aria-label={`Edit ${supply.name}`}
                            tooltip="Edit supply"
                            onClick={() => setEditingId(supply.id)}
                          >
                            <PencilIcon className="size-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/** Create/edit form for a single supply type. */
function SupplyForm({
  intent,
  supply,
  onDone,
}: {
  intent: "create" | "update";
  supply?: {
    id: string;
    name: string;
    description: string | null;
    category: SupplyCategory;
    quantityTotal: number;
    storageLocation: string | null;
    isConsumable: boolean;
  };
  onDone?: () => void;
}) {
  const disabled = useDisabled();
  const actionData = useActionData<DataOrErrorResponse>();
  /** Server-side errors, shown when client validation is bypassed or differs. */
  const validationErrors = getValidationErrors<typeof SupplyFormSchema>(
    actionData?.error
  );

  return (
    <Form method="post" className="flex flex-col gap-3">
      <input type="hidden" name="intent" value={intent} />
      {supply ? (
        <input type="hidden" name="supplyId" value={supply.id} />
      ) : null}

      <Input
        label="Name"
        name="name"
        required
        defaultValue={supply?.name}
        placeholder="25ft XLR cable"
        error={validationErrors?.name?.message}
        className="w-full"
        inputClassName="w-full"
      />

      <div>
        <label
          htmlFor="supply-category"
          className="mb-1.5 block text-text-sm font-medium text-gray-700"
        >
          Category
        </label>
        <select
          id="supply-category"
          name="category"
          defaultValue={supply?.category ?? SupplyCategory.CABLE}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        >
          {SUPPLY_CATEGORY_ORDER.map((category) => (
            <option key={category} value={category}>
              {SUPPLY_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>

      <Input
        label="How many do you own?"
        name="quantityTotal"
        type="number"
        min={0}
        required
        defaultValue={supply?.quantityTotal ?? 1}
        error={validationErrors?.quantityTotal?.message}
        className="w-full"
        inputClassName="w-full"
      />

      <Input
        label="Where are they kept? (optional)"
        name="storageLocation"
        defaultValue={supply?.storageLocation ?? ""}
        placeholder="Cable bin 3"
        className="w-full"
        inputClassName="w-full"
      />

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="isConsumable"
          defaultChecked={supply?.isConsumable}
          className="size-4 rounded border-gray-300"
        />
        Used up rather than returned (gaff tape, AA cells)
      </label>

      <div className="flex gap-2">
        <Button type="submit" disabled={disabled} className="flex-1">
          {disabled
            ? "Saving..."
            : intent === "create"
            ? "Add supply"
            : "Save changes"}
        </Button>
        {onDone ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={onDone}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </Form>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
