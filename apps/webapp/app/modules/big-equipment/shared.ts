/**
 * BIG Equipment — client-safe shared pieces
 *
 * Constants and pure helpers used by BOTH the server service and
 * client-rendered components (the member equipment info page, the admin
 * Guides tab). Must stay free of server-only imports — `service.server.ts`
 * imports from here, never the other way around (a route COMPONENT importing
 * from a `.server` module hard-fails the vite client build).
 *
 * NOTE: Prisma enum VALUES are `undefined` in the browser build, so client
 * components must use the string-literal {@link ASSET_GUIDE_KINDS} here, never
 * `AssetGuideKind.X`.
 *
 * @see {@link file://./service.server.ts}
 */

/** Guide kinds as string literals (browser-safe; mirrors `AssetGuideKind`). */
export const ASSET_GUIDE_KINDS = ["MANUAL", "VIDEO", "LINK"] as const;

/** A guide kind as the client knows it. */
export type AssetGuideKindString = (typeof ASSET_GUIDE_KINDS)[number];

/** Human labels for the guide kinds (admin form + member info page). */
export const ASSET_GUIDE_KIND_LABEL: Record<AssetGuideKindString, string> = {
  MANUAL: "Manual / document",
  VIDEO: "Video explainer",
  LINK: "Helpful link",
};

/**
 * Converts a pasted video URL into a privacy-friendly embed URL, or null when
 * the URL isn't an embeddable YouTube/Vimeo video (in which case callers
 * should render a plain link instead of an iframe — never embed arbitrary
 * hosts).
 *
 * Supported forms:
 * - youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID,
 *   youtube.com/embed/ID → youtube-nocookie.com/embed/ID
 * - vimeo.com/ID, player.vimeo.com/video/ID → player.vimeo.com/video/ID
 *
 * @param url - The guide URL as entered by the admin
 * @returns An embed URL safe to put in an iframe, or null
 */
export function videoEmbedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  /** YouTube video ids are 11 chars of [A-Za-z0-9_-]. */
  const youTubeId = /^[\w-]{11}$/;

  if (host === "youtube.com" || host === "m.youtube.com") {
    const fromWatch = parsed.searchParams.get("v");
    const fromPath = parsed.pathname.match(
      /^\/(?:embed|shorts|live)\/([\w-]{11})/
    )?.[1];
    const id = fromWatch ?? fromPath;
    return id && youTubeId.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  }
  if (host === "youtube-nocookie.com") {
    const id = parsed.pathname.match(/^\/embed\/([\w-]{11})/)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return youTubeId.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  }
  if (host === "vimeo.com") {
    const id = parsed.pathname.match(/^\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  if (host === "player.vimeo.com") {
    const id = parsed.pathname.match(/^\/video\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }

  return null;
}
