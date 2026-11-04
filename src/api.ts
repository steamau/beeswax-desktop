import { sanitizeText, wrapUntrusted } from "./untrusted.js";
import { currentWriteContext } from "./write_context.js";

// ── HTTP helper ────────────────────────────────────────────────────────────

export const BASE_URL = (process.env.BEESWAX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const API_TOKEN = process.env.BEESWAX_API_TOKEN ?? "";

type Query = Record<string, string | number | boolean | undefined>;

interface Pagination {
  total_count: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ApiResponse {
  body: unknown;
  pagination?: Pagination;
}

// --- Resilience: cap concurrency + retry transient origin/tunnel failures ----------
// A burst of parallel tool calls can otherwise stampede the origin (Puma serves a
// limited number of requests at once), producing Cloudflare 502/530s. We cap in-flight
// requests and retry transient gateway failures with exponential backoff + jitter.

const MAX_CONCURRENCY = Math.max(1, Number(process.env.BEESWAX_MAX_CONCURRENCY ?? 3));
const MAX_RETRIES = Math.max(0, Number(process.env.BEESWAX_MAX_RETRIES ?? 4));
// Gateway/transient statuses only — NOT 500 (a real app error; retrying a write could
// double-apply). 502/503/504/530 mean the request didn't reach the app; 429 is throttling.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 530]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Exponential backoff with jitter: ~0.25s, 0.5s, 1s, 2s, ... capped at 8s.
function backoffMs(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

// Minimal FIFO semaphore limiting concurrent in-flight HTTP requests.
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENCY) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter; inFlight stays constant
  } else {
    inFlight -= 1;
  }
}

export async function api(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Query; body?: unknown } = {}
): Promise<ApiResponse> {
  if (!API_TOKEN) {
    throw new Error(
      "BEESWAX_API_TOKEN is not set. Create a token in the Beeswax Shares app (Account → API Access) " +
        "and set it in this MCP server's environment."
    );
  }

  const url = new URL(`${BASE_URL}/api/v1${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  // Writes made inside a tool call carry its idempotency key and reasoning (write_context.ts).
  const write = method === "GET" ? undefined : currentWriteContext();
  const writeHeaders: Record<string, string> = {};
  if (write) {
    writeHeaders["Idempotency-Key"] = write.idempotencyKey;
    if (write.reasoning) writeHeaders["X-Reasoning"] = encodeURIComponent(write.reasoning);
  }

  await acquireSlot();
  try {
    let attempt = 0;
    while (true) {
      attempt += 1;

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            Accept: "application/json",
            ...writeHeaders,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
        });
      } catch (err) {
        // Network-level failure (origin unreachable / tunnel dropped). Retry a few times.
        if (attempt <= MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(
          `Could not reach the Beeswax Shares API at ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Origin overloaded / tunnel flapping / rate-limited: drain, back off, retry.
      if (RETRYABLE_STATUS.has(res.status) && attempt <= MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        await res.body?.cancel().catch(() => {});
        await sleep(waitMs);
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        const apiError =
          json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : text.slice(0, 300) || res.statusText;
        // Error bodies can echo request/document text — sanitize like any output.
        throw new Error(sanitizeText(`Beeswax API error (HTTP ${res.status}): ${apiError}`));
      }

      let pagination: Pagination | undefined;
      const totalCount = res.headers.get("X-Total-Count");
      if (totalCount !== null) {
        pagination = {
          total_count: Number(totalCount),
          page: Number(res.headers.get("X-Page") ?? 1),
          per_page: Number(res.headers.get("X-Per-Page") ?? 25),
          total_pages: Number(res.headers.get("X-Total-Pages") ?? 1)
        };
      }

      return { body: json, pagination };
    }
  } finally {
    releaseSlot();
  }
}

/**
 * Format an API response as MCP text content, appending pagination info when present.
 * All output is stripped of invisible/steering Unicode; pass `untrusted: true` for
 * tools whose payload embeds document/statement/feed-derived text — it is wrapped in
 * an explicit untrusted-data fence so the client model treats it as data, not
 * instructions (see untrusted.ts).
 */
export function toResult(response: ApiResponse, opts: { untrusted?: boolean } = {}) {
  let payload: unknown = response.body;
  if (
    response.pagination &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    payload = { ...(payload as Record<string, unknown>), pagination: response.pagination };
  }
  let text = sanitizeText(JSON.stringify(payload, null, 2));
  if (opts.untrusted) text = wrapUntrusted(text);
  return {
    content: [{ type: "text" as const, text }]
  };
}

export type Api = typeof api;
