/**
 * BIG Asset Condition & Maintenance log — service (server-only)
 *
 * A documented history of an asset's condition over time: dated entries (routine
 * condition report / damage / maintenance / inspection) with an optional grade,
 * a note, and optional photos. Photos reuse shelf's audit-image pipeline
 * (Supabase `PUBLIC_BUCKET` + generated thumbnail + permanent public URL).
 *
 * Additive (BIG-only): the models carry plain `assetId`/`organizationId` columns
 * (no relations added to `Asset`), and every query is org-scoped.
 *
 * @see {@link file://./../audit/image.service.server.ts} — the upload pattern mirrored here
 * @see {@link file://./../../routes/_layout+/assets.$assetId.condition.tsx}
 */
import { createId } from "@paralleldrive/cuid2";
import {
  AssetConditionGrade,
  AssetConditionType,
  type AssetConditionLog,
} from "@prisma/client";
import { z } from "zod";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
  PUBLIC_BUCKET,
} from "~/utils/constants";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import { parseFileFormData } from "~/utils/storage.server";

const label = "Asset Condition" as const;

/** Validates the condition-entry form fields (parsed alongside the optional photo). */
const ConditionEntrySchema = z.object({
  type: z.nativeEnum(AssetConditionType),
  grade: z
    .union([z.nativeEnum(AssetConditionGrade), z.literal("")])
    .optional()
    .transform((v) => (v ? v : null)),
  note: z.string().trim().min(1, "Please add a note describing the condition"),
});

/**
 * Lists an asset's condition entries (newest first), each with its photos.
 * Org-scoped.
 *
 * @param args.assetId - The asset id
 * @param args.organizationId - The caller's org (scoping guard)
 */
export async function getAssetConditionLog({
  assetId,
  organizationId,
}: {
  assetId: string;
  organizationId: string;
}) {
  return db.assetConditionLog.findMany({
    where: { assetId, organizationId },
    include: {
      images: {
        select: { id: true, imageUrl: true, thumbnailUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Creates a condition entry from a multipart request (fields + optional single
 * photo). Parses the request ONCE (uploading any photo to Supabase storage),
 * creates the entry, then attaches the photo if present.
 *
 * @param args.request - The multipart request
 * @param args.assetId - The asset the entry documents
 * @param args.organizationId - The caller's org
 * @param args.createdById - The staff user creating the entry
 * @returns The created {@link AssetConditionLog}
 * @throws {ShelfError} 400 on invalid input; wraps upload/db failures
 */
export async function createConditionEntryFromRequest({
  request,
  assetId,
  organizationId,
  createdById,
}: {
  request: Request;
  assetId: string;
  organizationId: string;
  createdById: string;
}): Promise<AssetConditionLog> {
  try {
    // Parse the multipart body once. This uploads any attached photo to the
    // public bucket and passes the non-file text fields through.
    const formData = await parseFileFormData({
      request,
      bucketName: PUBLIC_BUCKET,
      newFileName: `${organizationId}/asset-condition/${assetId}/${createId()}`,
      resizeOptions: { width: 1200, withoutEnlargement: true },
      generateThumbnail: true,
      thumbnailSize: 108,
      maxFileSize: DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
    });

    const parsed = ConditionEntrySchema.safeParse({
      type: formData.get("type"),
      grade: formData.get("grade") ?? "",
      note: formData.get("note"),
    });
    if (!parsed.success) {
      throw new ShelfError({
        cause: parsed.error,
        message:
          parsed.error.issues[0]?.message ??
          "Please complete the condition form.",
        label,
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const entry = await db.assetConditionLog.create({
      data: {
        assetId,
        organizationId,
        type: parsed.data.type,
        grade: parsed.data.grade,
        note: parsed.data.note,
        createdById,
      },
    });

    // Attach a photo if one was uploaded.
    const image = formData.get("image") as string | null;
    if (image) {
      let imagePath = image;
      let thumbnailPath: string | null = null;
      try {
        const p = JSON.parse(image);
        if (p.originalPath) {
          imagePath = p.originalPath;
          thumbnailPath = p.thumbnailPath ?? null;
        }
      } catch {
        // `image` is a plain path string (no thumbnail)
      }

      const {
        data: { publicUrl: imageUrl },
      } = getSupabaseAdmin()
        .storage.from(PUBLIC_BUCKET)
        .getPublicUrl(imagePath);

      let thumbnailUrl: string | null = null;
      if (thumbnailPath) {
        const {
          data: { publicUrl },
        } = getSupabaseAdmin()
          .storage.from(PUBLIC_BUCKET)
          .getPublicUrl(thumbnailPath);
        thumbnailUrl = publicUrl;
      }

      await db.assetConditionImage.create({
        data: {
          conditionLogId: entry.id,
          organizationId,
          imageUrl,
          thumbnailUrl,
          uploadedById: createdById,
        },
      });
    }

    return entry;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Could not save the condition entry",
      additionalData: { assetId },
      label,
      status: isLikeShelfError(cause) ? cause.status : 500,
      shouldBeCaptured: !isLikeShelfError(cause),
    });
  }
}
