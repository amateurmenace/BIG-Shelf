/**
 * Google Calendar integration (server-only)
 *
 * Pushes BIG's room bookings onto a shared "Room Bookings" Google Calendar so
 * the whole team sees the studio schedule inside Google Workspace. Auth is a
 * Google **service account**: we sign a short-lived JWT with its private key
 * (RS256 via `jsonwebtoken` — no googleapis dependency) and exchange it for an
 * access token. The team creates the calendar once and shares it with the
 * service-account email with "Make changes to events" permission; we then talk
 * to the Calendar REST API v3 directly.
 *
 * Design rules (mirrors the Neon CRM client): no-op/clear guard when
 * unconfigured, all failures wrapped in `ShelfError`, server-only (`.server.ts`).
 *
 * Event IDs are chosen by US (deterministic per booking+room, see
 * `~/modules/big-room-calendar`), which makes every push idempotent: insert →
 * 409 conflict → update. Google tombstones deleted IDs (they can't be
 * re-inserted), so the update path also revives a previously-cancelled event by
 * PUTting `status: "confirmed"`.
 *
 * @see https://developers.google.com/identity/protocols/oauth2/service-account
 * @see https://developers.google.com/calendar/api/v3/reference/events
 * @see {@link file://./../../modules/big-room-calendar/service.server.ts}
 */
import jwt from "jsonwebtoken";
import {
  GOOGLE_CALENDAR_SA_EMAIL,
  GOOGLE_CALENDAR_SA_PRIVATE_KEY,
  GOOGLE_ROOM_CALENDAR_ID,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";

const label = "Room Calendar" as const;

/** OAuth2 token endpoint for service-account JWT-bearer exchange. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Scope for event CRUD on calendars shared with the service account. */
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Calendar REST API v3 base. */
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * A Calendar API event resource as this app writes it. `id` must be lowercase
 * base32hex (`[a-v0-9]`) — the room-calendar module hex-encodes its keys, which
 * satisfies that alphabet.
 */
export type GoogleCalendarEvent = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  /** One of Google's 11 fixed event colors ("1"–"11"). */
  colorId?: string;
  /** Always "confirmed" — a PUT with this revives a tombstoned (deleted) id. */
  status: "confirmed";
  /** Traceability back to the shelf booking/room that produced the event. */
  extendedProperties?: { private: Record<string, string> };
  source?: { title: string; url: string };
};

/** True when the service account + target calendar are fully configured. */
export function isGoogleCalendarConfigured(): boolean {
  return Boolean(
    GOOGLE_CALENDAR_SA_EMAIL &&
      GOOGLE_CALENDAR_SA_PRIVATE_KEY &&
      GOOGLE_ROOM_CALENDAR_ID
  );
}

/**
 * The service-account email — surfaced on the admin setup page so staff know
 * which address to share the calendar with. Empty string when unconfigured.
 */
export function getServiceAccountEmail(): string {
  return GOOGLE_CALENDAR_SA_EMAIL ?? "";
}

/** Cached access token (module scope) — service-account tokens last ~1 hour. */
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a valid access token for the Calendar API, minting a new one via the
 * JWT-bearer flow when the cache is empty or near expiry.
 *
 * @throws {ShelfError} If unconfigured or the token exchange fails
 */
async function getAccessToken(): Promise<string> {
  if (!isGoogleCalendarConfigured()) {
    throw new ShelfError({
      cause: null,
      message: "Google Calendar is not configured",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }

  // Reuse until 5 minutes before expiry.
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // Fly secrets store multi-line PEMs with literal "\n" — restore real newlines.
  const privateKey = GOOGLE_CALENDAR_SA_PRIVATE_KEY.replace(/\\n/g, "\n");

  const assertion = jwt.sign({ scope: GOOGLE_CALENDAR_SCOPE }, privateKey, {
    algorithm: "RS256",
    issuer: GOOGLE_CALENDAR_SA_EMAIL,
    audience: GOOGLE_TOKEN_URL,
    expiresIn: 3600,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new ShelfError({
      cause: null,
      message: `Google token exchange failed (${response.status}). Check the service-account key.`,
      additionalData: { status: response.status },
      label,
    });
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new ShelfError({
      cause: null,
      message: "Google token response did not include an access token",
      label,
    });
  }

  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

/**
 * Low-level authenticated fetch against the Calendar API for the configured
 * room calendar. Returns the raw Response so callers can branch on status
 * (e.g. 409 on insert-conflict, 404/410 on already-deleted).
 */
async function calendarFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getAccessToken();
  const calendarId = encodeURIComponent(GOOGLE_ROOM_CALENDAR_ID);

  return fetch(`${CALENDAR_API_BASE}/calendars/${calendarId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });
}

/**
 * Creates or updates an event by its deterministic id (idempotent). Insert
 * first; on 409 (id exists — live or tombstoned) fall through to a full PUT,
 * which both updates live events and revives cancelled ones.
 *
 * @param event - The full event resource, including its deterministic `id`
 * @throws {ShelfError} If unconfigured or Google rejects both writes
 */
export async function upsertCalendarEvent(
  event: GoogleCalendarEvent
): Promise<void> {
  const insert = await calendarFetch(`/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (insert.ok) {
    return;
  }

  if (insert.status !== 409) {
    throw new ShelfError({
      cause: null,
      message: `Google Calendar insert failed (${insert.status})`,
      additionalData: { status: insert.status, eventId: event.id },
      label,
    });
  }

  // Id already exists (or is tombstoned) → full update revives/refreshes it.
  const update = await calendarFetch(
    `/events/${encodeURIComponent(event.id)}`,
    { method: "PUT", body: JSON.stringify(event) }
  );
  if (!update.ok) {
    throw new ShelfError({
      cause: null,
      message: `Google Calendar update failed (${update.status})`,
      additionalData: { status: update.status, eventId: event.id },
      label,
    });
  }
}

/**
 * Deletes an event by id. Missing/already-deleted events (404/410) count as
 * success so deletes are idempotent.
 *
 * @throws {ShelfError} If unconfigured or Google returns another error
 */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const response = await calendarFetch(
    `/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
  if (response.ok || response.status === 404 || response.status === 410) {
    return;
  }
  throw new ShelfError({
    cause: null,
    message: `Google Calendar delete failed (${response.status})`,
    additionalData: { status: response.status, eventId },
    label,
  });
}

/**
 * Lists the ids of all NOT-yet-ended events on the room calendar (paged).
 * Powers the admin "Sync now" reconcile: events whose booking no longer needs
 * them get pruned. Past events are never listed, so history is never touched.
 *
 * @returns Ids of events whose end time is in the future
 * @throws {ShelfError} If unconfigured or a page request fails
 */
export async function listUpcomingCalendarEventIds(): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      maxResults: "250",
      singleEvents: "true",
      // Only the ids are needed; trim the payload.
      fields: "items(id),nextPageToken",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await calendarFetch(`/events?${params.toString()}`);
    if (!response.ok) {
      throw new ShelfError({
        cause: null,
        message: `Google Calendar list failed (${response.status})`,
        additionalData: { status: response.status },
        label,
      });
    }

    const json = (await response.json()) as {
      items?: { id?: string }[];
      nextPageToken?: string;
    };
    for (const item of json.items ?? []) {
      if (item.id) {
        ids.push(item.id);
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return ids;
}
