#!/usr/bin/env node
/**
 * Beeswax Shares MCP server.
 *
 * A thin stdio MCP client over the Beeswax Shares JSON API (Rails, /api/v1).
 * Used by Claude Desktop / Claude Code for SMSF portfolio record-keeping.
 *
 * Env:
 *   BEESWAX_URL        — base URL of the app (default http://localhost:3000)
 *   BEESWAX_API_TOKEN  — API token, sent as `Authorization: Bearer <token>`
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sanitizeText, wrapUntrusted, SERVER_INSTRUCTIONS } from "./untrusted.js";

// ── HTTP helper ────────────────────────────────────────────────────────────

const BASE_URL = (process.env.BEESWAX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const API_TOKEN = process.env.BEESWAX_API_TOKEN ?? "";

type Query = Record<string, string | number | boolean | undefined>;

interface Pagination {
  total_count: number;
  page: number;
  per_page: number;
  total_pages: number;
}

interface ApiResponse {
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

async function api(
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
function toResult(response: ApiResponse, opts: { untrusted?: boolean } = {}) {
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

// ── Shared schema fragments ────────────────────────────────────────────────

const fundId = z.number().int().positive().describe("Fund ID (discover via whoami or list_funds)");
const isoDate = (what: string) => z.string().describe(`${what} as an ISO date, e.g. "2026-05-30"`);
const pageParam = z.number().int().positive().optional().describe("Page number (default 1)");
const perPageParam = z
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe("Results per page (default 25, max 100)");

// ── Server + tools ─────────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: "beeswax-shares",
    version: "1.2.0"
  },
  { instructions: SERVER_INSTRUCTIONS }
);

// MCP tool annotations (hints for the client harness — e.g. to require
// confirmation before non-read-only calls).
const READS = { readOnlyHint: true } as const;
// Additive/derived writes: create rows or recompute derived state; reversible.
const WRITES = { readOnlyHint: false, destructiveHint: false } as const;
// Overwrites or discards existing data.
const WRITES_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    annotations: READS,
    description:
      "Identify the authenticated Beeswax Shares user, the API token's scopes, and the SMSF funds the token " +
      "can access (with their fund IDs). Call this FIRST in a session to discover fund IDs — almost every " +
      "other tool needs a fund_id.",
    inputSchema: {}
  },
  async () => toResult(await api("GET", "/me"))
);

server.registerTool(
  "list_funds",
  {
    title: "List funds",
    annotations: READS,
    description:
      "List your SMSF funds with headline figures: total value, cost base, unrealised gain/loss, total " +
      "income, true return percentages, active holdings count and current financial year. Use when you need " +
      "fund-level numbers; use whoami if you only need fund IDs.",
    inputSchema: { page: pageParam, per_page: perPageParam }
  },
  async ({ page, per_page }) => toResult(await api("GET", "/funds", { query: { page, per_page } }))
);

server.registerTool(
  "get_portfolio",
  {
    title: "Get portfolio snapshot",
    annotations: READS,
    description:
      "Full portfolio snapshot for one SMSF fund: fund summary (value, cost base, unrealised gain/loss, " +
      "income, true return), asset allocation percentages, and every active holding with current value and " +
      "returns. The best single call to answer 'how is the fund doing?' or 'what do we hold?'. All amounts AUD.",
    inputSchema: { fund_id: fundId }
  },
  async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/portfolio`))
);

server.registerTool(
  "list_holdings",
  {
    title: "List holdings",
    annotations: READS,
    description:
      "List holdings in a fund, with filters. Use to find a holding's ID by ticker or name (e.g. before " +
      "record_cost or update_price), or to review holdings by status. Returns valuation and gain/loss per holding.",
    inputSchema: {
      fund_id: fundId,
      status: z.string().optional().describe('Filter by holding status, e.g. "active" or "sold"'),
      ticker: z.string().optional().describe('Exact ticker symbol match (case-insensitive), e.g. "VAS"'),
      search: z.string().optional().describe("Substring search over holding name and ticker"),
      page: pageParam,
      per_page: perPageParam
    }
  },
  async ({ fund_id, status, ticker, search, page, per_page }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/holdings`, {
        query: { status, ticker, search, page, per_page }
      })
    )
);

server.registerTool(
  "get_holding_analysis",
  {
    title: "Get holding analysis",
    annotations: READS,
    description:
      "Deep analysis of a single holding: true return (income + growth − costs), annualised return, income " +
      "totals (dividends, distributions, interest, rent, franking credits), costs to date, CGT discount " +
      "eligibility, estimated CGT and net proceeds if sold today. Use when asked how a specific " +
      "investment has really performed, or about the tax impact of selling. All amounts AUD.",
    inputSchema: {
      fund_id: fundId,
      holding_id: z.number().int().positive().describe("Holding ID (find via list_holdings)")
    }
  },
  async ({ fund_id, holding_id }) =>
    toResult(await api("GET", `/funds/${fund_id}/holdings/${holding_id}/analysis`))
);

server.registerTool(
  "search_transactions",
  {
    title: "Search transactions",
    annotations: READS,
    description:
      "Search the fund's transaction ledger across all holdings — this is the 'memory recall' tool for " +
      "your SMSF record-keeping. Use to answer 'did we already record this dividend?', 'what did we buy " +
      "in FY 2025-26?', or to check for duplicates before proposing a new record. Filter by type, financial " +
      "year, date range and ticker. Results are newest-first and paginated.",
    inputSchema: {
      fund_id: fundId,
      transaction_type: z
        .string()
        .optional()
        .describe('Filter by type, e.g. "buy", "sell", "dividend", "distribution", "interest", "rental_income"'),
      financial_year: z
        .string()
        .optional()
        .describe('Australian financial year label, e.g. "2025-26" (July–June)'),
      from: isoDate("Earliest transaction date (inclusive)").optional(),
      to: isoDate("Latest transaction date (inclusive)").optional(),
      ticker: z.string().optional().describe('Exact ticker symbol (case-insensitive), e.g. "BHP"'),
      page: pageParam,
      per_page: perPageParam
    }
  },
  async ({ fund_id, transaction_type, financial_year, from, to, ticker, page, per_page }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/transactions`, {
        query: { transaction_type, financial_year, from, to, ticker, page, per_page }
      }),
      { untrusted: true }
    )
);

server.registerTool(
  "create_holding",
  {
    title: "Create holding",
    annotations: WRITES,
    description:
      "Create a brand-new holding (security/asset) in the fund — use ONLY when a security was purchased that " +
      "the fund has never held before (check list_holdings first). For buys of an existing holding, use " +
      "record_trade instead. Note: unlike the record_* tools, this writes the holding directly; the buy " +
      "transaction itself should still go through record_trade for human review.",
    inputSchema: {
      fund_id: fundId,
      name: z.string().describe('Security name, e.g. "Vanguard Australian Shares Index ETF"'),
      ticker_symbol: z.string().optional().describe('Ticker, e.g. "VAS"'),
      exchange: z.string().optional().describe('Exchange, e.g. "ASX"'),
      asset_type: z
        .string()
        .optional()
        .describe(
          'Asset type by name or category string, e.g. "ETF" or "equity" (see list_asset_types). Defaults to equity.'
        ),
      broker_id: z.number().int().positive().optional().describe("Broker ID (see list_brokers)"),
      acquisition_date: isoDate("Acquisition date").optional(),
      quantity: z.number().optional().describe("Units acquired"),
      purchase_price_per_unit: z.number().optional().describe("Purchase price per unit in AUD"),
      currency: z.string().optional().describe('Currency code (default "AUD")'),
      notes: z.string().optional()
    }
  },
  async ({ fund_id, ...holding }) =>
    toResult(await api("POST", `/funds/${fund_id}/holdings`, { body: { holding } }))
);

server.registerTool(
  "record_trade",
  {
    title: "Record trade",
    annotations: WRITES,
    description:
      "Record a buy or sell directly to your SMSF ledger. This writes immediately — there is no review " +
      "step. Use whenever a trade is found in an email, contract note or conversation. Identify the holding " +
      "by ticker or holding_id; the holding must already exist (use create_holding first if it doesn't). " +
      "Always pass external_ref when the source has a stable ID (e.g. email message id + ticker + date) — it " +
      "is an idempotency key, so re-running the same import will not create duplicates. Pass reasoning to " +
      "record why (it is saved on the ledger entry for the audit trail). Amounts in AUD unless currency says otherwise.",
    inputSchema: {
      fund_id: fundId,
      transaction_type: z.enum(["buy", "sell"]).describe("Trade direction"),
      transaction_date: isoDate("Trade date"),
      ticker: z.string().optional().describe("Ticker symbol of the holding (preferred way to identify it)"),
      holding_id: z.number().int().positive().optional().describe("Holding ID, if already known"),
      quantity: z.number().optional().describe("Units bought/sold"),
      price_per_unit: z.number().optional().describe("Price per unit"),
      total_amount: z.number().describe("Total consideration (AUD unless currency set)"),
      broker_fee: z.number().optional().describe("Brokerage fee"),
      currency: z.string().optional().describe('Currency code (default "AUD")'),
      reasoning: z.string().optional().describe("Why this trade is recorded (cite the source) — saved to the audit trail"),
      notes: z.string().optional(),
      external_ref: z
        .string()
        .optional()
        .describe("Idempotency key derived from the source, e.g. '<email-message-id>:VAS:2026-05-30'")
    }
  },
  async ({ fund_id, external_ref, ...transaction }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/transactions`, {
        query: { external_ref },
        body: { transaction }
      })
    )
);

server.registerTool(
  "record_income",
  {
    title: "Record income",
    annotations: WRITES,
    description:
      "Record an income event — dividend, distribution, interest or rental income — directly to your " +
      "SMSF ledger. This writes immediately; there is no review step. Use when a dividend statement, " +
      "distribution advice or rent receipt is found. Identify the holding by ticker or holding_id (it must " +
      "already exist). Include franking_credits for franked dividends (important for SMSF tax). Always pass " +
      "external_ref when the source has a stable ID so repeat imports are idempotent. Pass reasoning to record " +
      "why (saved for the audit trail). All amounts AUD unless currency says otherwise.",
    inputSchema: {
      fund_id: fundId,
      transaction_type: z
        .enum(["dividend", "distribution", "interest", "rental_income"])
        .describe("Income type"),
      transaction_date: isoDate("Income date (usually the payment date)"),
      ticker: z.string().optional().describe("Ticker symbol of the holding (preferred way to identify it)"),
      holding_id: z.number().int().positive().optional().describe("Holding ID, if already known"),
      total_amount: z.number().describe("Cash amount received (AUD unless currency set)"),
      franking_credits: z
        .number()
        .optional()
        .describe("Franking credits attached (AUD) — for franked dividends"),
      payment_date: isoDate("Payment date").optional(),
      ex_dividend_date: isoDate("Ex-dividend date").optional(),
      currency: z.string().optional().describe('Currency code (default "AUD")'),
      reasoning: z.string().optional().describe("Why this income is recorded (cite the source) — saved to the audit trail"),
      notes: z.string().optional(),
      external_ref: z
        .string()
        .optional()
        .describe("Idempotency key derived from the source, e.g. '<email-message-id>:VAS:2026-03-28'")
    }
  },
  async ({ fund_id, external_ref, ...transaction }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/transactions`, {
        query: { external_ref },
        body: { transaction }
      })
    )
);

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv"
};

server.registerTool(
  "upload_document",
  {
    title: "Upload document",
    annotations: WRITES,
    description:
      "Upload a local PDF or CSV (broker statement, contract note, dividend statement, annual tax statement) " +
      "into the fund's document store. Reads the file from disk, base64-encodes it and posts it; the server " +
      "then automatically extracts statement lines and reconciles them against the ledger — unmatched lines " +
      "become pending proposals in the Review Queue. Use get_document afterwards to check extraction and " +
      "match results.",
    inputSchema: {
      fund_id: fundId,
      file_path: z.string().describe("Absolute path to the local PDF or CSV file"),
      kind: z
        .string()
        .optional()
        .describe(
          'Document kind, e.g. "broker_statement", "contract_note", "dividend_statement" (default "broker_statement")'
        ),
      title: z.string().optional().describe("Human-friendly title (defaults from the file)"),
      content_type: z
        .string()
        .optional()
        .describe("MIME type override; inferred from extension (.pdf/.csv) if omitted"),
      period_start: isoDate("Statement period start").optional(),
      period_end: isoDate("Statement period end").optional()
    }
  },
  async ({ fund_id, file_path, kind, title, content_type, period_start, period_end }) => {
    let data: Buffer;
    try {
      data = await readFile(file_path);
    } catch (err) {
      throw new Error(
        `Could not read file at ${file_path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const inferred = CONTENT_TYPES[extname(file_path).toLowerCase()];
    const resolvedType = content_type ?? inferred;
    if (!resolvedType) {
      throw new Error(
        `Cannot infer content type for "${extname(file_path)}" — pass content_type explicitly (PDF and CSV are supported).`
      );
    }
    return toResult(
      await api("POST", `/funds/${fund_id}/documents`, {
        body: {
          document: {
            kind,
            title,
            file_base64: data.toString("base64"),
            filename: basename(file_path),
            content_type: resolvedType,
            period_start,
            period_end
          }
        }
      }),
      { untrusted: true }
    );
  }
);

server.registerTool(
  "get_document",
  {
    title: "Get document",
    annotations: READS,
    description:
      "Fetch one uploaded document including its extracted statement lines, each with a match_status " +
      "(matched / discrepancy / proposed / unmatched) against the ledger. Use after upload_document to check " +
      "whether extraction finished (status field) and what the reconciliation found. Extraction runs in the " +
      "background, so poll this if status is still 'processing'.",
    inputSchema: {
      fund_id: fundId,
      document_id: z.number().int().positive().describe("Document ID (from upload_document or list_documents)")
    }
  },
  async ({ fund_id, document_id }) =>
    toResult(await api("GET", `/funds/${fund_id}/documents/${document_id}`), { untrusted: true })
);

server.registerTool(
  "list_documents",
  {
    title: "List documents",
    annotations: READS,
    description:
      "List the fund's uploaded documents (statements, contract notes etc.), newest first, with extraction " +
      "status and reconciliation summaries. Use to check whether a statement was already uploaded before " +
      "uploading it again, or to find a document ID.",
    inputSchema: {
      fund_id: fundId,
      status: z
        .string()
        .optional()
        .describe('Filter by document status, e.g. "pending", "processing", "extracted", "reconciled", "failed"'),
      page: pageParam,
      per_page: perPageParam
    }
  },
  async ({ fund_id, status, page, per_page }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/documents`, { query: { status, page, per_page } }),
      { untrusted: true }
    )
);

server.registerTool(
  "reconcile_document",
  {
    title: "Reconcile document",
    annotations: WRITES,
    description:
      "Re-run reconciliation of a document's extracted statement lines against the fund's ledger. Returns " +
      "the document with refreshed line match statuses plus a summary including matched, discrepancies, " +
      "proposed, and missing_from_statement. Use after the ledger changed (e.g. proposals were approved) or " +
      "when you want to re-check a statement.",
    inputSchema: {
      fund_id: fundId,
      document_id: z.number().int().positive().describe("Document ID to reconcile")
    }
  },
  async ({ fund_id, document_id }) =>
    toResult(await api("POST", `/funds/${fund_id}/documents/${document_id}/reconcile`), {
      untrusted: true
    })
);

server.registerTool(
  "record_cost",
  {
    title: "Record cost entry",
    annotations: WRITES,
    description:
      "Record a holding-level cost/expense for the SMSF — e.g. property rates, insurance, management fees, " +
      "registry fees. Writes directly to the holding's cost ledger (costs are low-risk records, unlike " +
      "trades/income which go through proposals). Mark tax_deductible appropriately — it feeds the fund's " +
      "true-return and tax calculations. Amounts in AUD.",
    inputSchema: {
      fund_id: fundId,
      holding_id: z.number().int().positive().describe("Holding the cost belongs to (find via list_holdings)"),
      cost_type: z
        .string()
        .describe('Cost category, e.g. "insurance", "rates", "management_fee", "accounting", "other"'),
      description: z.string().optional().describe("What the cost was for"),
      amount: z.number().describe("Cost amount in AUD"),
      date_incurred: isoDate("Date the cost was incurred"),
      tax_deductible: z.boolean().optional().describe("Whether the cost is tax deductible for the SMSF"),
      notes: z.string().optional()
    }
  },
  async ({ fund_id, holding_id, ...cost_entry }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/holdings/${holding_id}/cost_entries`, {
        body: { cost_entry }
      })
    )
);

server.registerTool(
  "update_price",
  {
    title: "Update price",
    annotations: WRITES_DESTRUCTIVE,
    description:
      "Record a price observation for a holding (e.g. from a market quote, property valuation or fund unit " +
      "price). Upserts by date and, if it is the newest observation, also updates the holding's current " +
      "price so portfolio values refresh. Use when you have an updated valuation or a " +
      "reliable quoted price. Price in AUD per unit.",
    inputSchema: {
      fund_id: fundId,
      holding_id: z.number().int().positive().describe("Holding to price (find via list_holdings)"),
      date: isoDate("Date of the price observation"),
      price: z.number().describe("Price per unit in AUD"),
      source: z
        .string()
        .optional()
        .describe('Where the price came from, e.g. "asx_close", "valuation", "manual" (default "api")')
    }
  },
  async ({ fund_id, holding_id, ...price_history }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/holdings/${holding_id}/price_histories`, {
        body: { price_history }
      })
    )
);

server.registerTool(
  "list_brokers",
  {
    title: "List brokers",
    annotations: READS,
    description:
      "List the brokers known to Beeswax Shares (with broker IDs and CHESS sponsorship info). Use to find a " +
      "broker_id before create_holding, or to interpret broker references in statements.",
    inputSchema: {}
  },
  async () => toResult(await api("GET", "/brokers"))
);

server.registerTool(
  "list_asset_types",
  {
    title: "List asset types",
    annotations: READS,
    description:
      "List the asset types supported by Beeswax Shares (name, category, and whether the type carries " +
      "tickers, dividends or franking credits). Use to pick a valid asset_type for create_holding or to " +
      "understand the fund's asset allocation categories.",
    inputSchema: {}
  },
  async () => toResult(await api("GET", "/asset_types"))
);

server.registerTool(
  "list_bank_accounts",
  {
    title: "List bank accounts",
    annotations: READS,
    description:
      "List the SMSF's bank accounts with current balance, opening balance, role and feed status. Use to " +
      "find a bank_account_id before list_cash_transactions or record_cash_transaction, or to see cash on " +
      "hand. All amounts AUD.",
    inputSchema: { fund_id: fundId }
  },
  async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/bank_accounts`))
);

server.registerTool(
  "create_bank_account",
  {
    title: "Create bank account",
    annotations: WRITES,
    description:
      "Create a new cash/bank account under a fund — e.g. a nabtrade cash hub, term deposit or operating " +
      "account — so its cash ledger can be tracked and reconciled. Use when a statement or CSV belongs to an " +
      "account the fund doesn't have yet (check list_bank_accounts first to avoid duplicates). Returns the new " +
      "account with its id; follow up with record_cash_transaction to load its movements. Currency is AUD " +
      "(v1 is AUD-only). Opening balance defaults to 0.",
    inputSchema: {
      fund_id: fundId,
      name: z.string().describe('Account name, e.g. "nabtrade High Interest NT1975568-005"'),
      institution_name: z.string().optional().describe('Bank/institution, e.g. "National Australia Bank"'),
      account_role: z
        .enum(["operating", "term_deposit", "pension", "contributions"])
        .optional()
        .describe('Role of the account (default "operating")'),
      opening_balance: z.number().optional().describe("Opening balance in AUD (default 0)"),
      opening_balance_date: isoDate("Date the opening balance applies from").optional(),
      status: z
        .enum(["active", "inactive", "closed"])
        .optional()
        .describe('Account status (default "active")'),
      bsb: z.string().optional().describe("BSB (stored encrypted)"),
      account_number_masked: z.string().optional().describe("Account number / masked number"),
      account_holder_name: z.string().optional().describe("Account holder name (stored encrypted)"),
      notes: z.string().optional()
    }
  },
  async ({ fund_id, ...bank_account }) =>
    toResult(await api("POST", `/funds/${fund_id}/bank_accounts`, { body: { bank_account } }))
);

server.registerTool(
  "list_cash_transactions",
  {
    title: "List cash transactions",
    annotations: READS,
    description:
      "List the cash-ledger movements on a bank account — deposits, withdrawals, contributions, fees, " +
      "interest, settlements — newest-first and paginated. Filter by category, match status, financial year " +
      "or date range. Use to review cash flow, check whether a movement was already recorded, or find " +
      "uncategorised/unmatched items. Amounts are signed (+ in / − out), AUD.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: z.number().int().positive().describe("Bank account ID (find via list_bank_accounts)"),
      category: z
        .string()
        .optional()
        .describe('Filter by category, e.g. "income_bank_interest", "expense_bank_fee", "contribution_concessional"'),
      match_status: z
        .string()
        .optional()
        .describe('Filter by match status: "unmatched", "matched", "proposed", "ignored", "reconciled"'),
      financial_year: z.string().optional().describe('Australian financial year label, e.g. "2025-26"'),
      from: isoDate("Earliest posted date (inclusive)").optional(),
      to: isoDate("Latest posted date (inclusive)").optional(),
      page: pageParam,
      per_page: perPageParam
    }
  },
  async ({ fund_id, bank_account_id, category, match_status, financial_year, from, to, page, per_page }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions`, {
        query: { category, match_status, financial_year, from, to, page, per_page }
      }),
      { untrusted: true }
    )
);

server.registerTool(
  "record_cash_transaction",
  {
    title: "Record cash transaction",
    annotations: WRITES,
    description:
      "Record a cash movement directly on a bank account — a contribution, fee, interest, pension/benefit " +
      "payment, transfer or tax payment — for accounts with no live bank feed, or one-off entries. Writes " +
      "directly to the cash ledger (low-risk record-keeping, like record_cost; feed-sourced rows arrive " +
      "automatically instead). Amount is SIGNED: positive = money in (credit), negative = money out (debit), " +
      "AUD. Contributions and benefit payments require fund_member_id. Pass external_ref as an idempotency " +
      "key so re-running an import won't duplicate.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: z
        .number()
        .int()
        .positive()
        .describe("Bank account the movement belongs to (find via list_bank_accounts)"),
      posted_date: isoDate("Date the transaction posted"),
      amount: z.number().describe("Signed amount in AUD: positive = money in, negative = money out"),
      category: z
        .string()
        .describe(
          'SMSF category, e.g. "income_bank_interest", "expense_bank_fee", "contribution_concessional", ' +
            '"pension_payment", "tax_income_payment", "internal_transfer" (default "uncategorised")'
        ),
      reference: z.string().optional().describe("Bank/statement reference"),
      description: z.string().optional().describe("Narration"),
      fund_member_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Member the contribution/benefit belongs to (required for contribution_* and pension/benefit)"),
      contribution_type: z
        .string()
        .optional()
        .describe('For contributions: "concessional", "non_concessional", "employer_sg", "spouse", "government_cocontribution"'),
      tax_component: z
        .string()
        .optional()
        .describe('For tax rows: "payg", "income_tax", "refund", "franking_refund", "division_296"'),
      tax_deductible: z.boolean().optional(),
      external_ref: z.string().optional().describe("Stable source ID for idempotency (e.g. statement line id)")
    }
  },
  async ({ fund_id, bank_account_id, external_ref, ...cash_transaction }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions`, {
        query: { external_ref },
        body: { cash_transaction }
      })
    )
);

server.registerTool(
  "update_cash_transaction",
  {
    title: "Update / recategorise a cash transaction",
    annotations: WRITES_DESTRUCTIVE,
    description:
      "Edit an existing cash-ledger row — most importantly to (re)assign its category (e.g. move a settlement " +
      "credit from \"uncategorised\" to \"settlement_sell\"), but also its description, reference, posted date or " +
      "amount. Find the row via list_cash_transactions. This is a plain field edit — it does NOT change " +
      "settlement linkage or match status (use attribute_cash_transaction / detach_cash_transaction for income " +
      "linkage). Blocked if the row's financial year is locked (reopen the year first).",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: z
        .number()
        .int()
        .positive()
        .describe("Bank account the row is on (find via list_bank_accounts)"),
      cash_transaction_id: z
        .number()
        .int()
        .positive()
        .describe("The cash row to edit (find via list_cash_transactions)"),
      category: z
        .string()
        .optional()
        .describe('New SMSF category, e.g. "settlement_sell", "income_dividend", "internal_transfer", "expense_bank_fee"'),
      description: z.string().optional().describe("New narration"),
      reference: z.string().optional().describe("New bank/statement reference"),
      posted_date: isoDate("New posted date").optional(),
      amount: z.number().optional().describe("New signed amount in AUD: positive = money in, negative = money out"),
      tax_component: z
        .string()
        .optional()
        .describe('For tax rows: "payg", "income_tax", "refund", "franking_refund", "division_296"'),
      tax_deductible: z.boolean().optional(),
      notes: z.string().optional()
    }
  },
  async ({ fund_id, bank_account_id, cash_transaction_id, ...cash_transaction }) =>
    toResult(
      await api(
        "PATCH",
        `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}`,
        { body: { cash_transaction } }
      )
    )
);

server.registerTool(
  "attribute_cash_transaction",
  {
    title: "Attribute cash income to a holding",
    annotations: WRITES,
    description:
      "Link an income credit already sitting on a bank account — e.g. a dividend or distribution that landed " +
      "via the bank feed — to the holding that earned it. Recognises the income on a NEW security transaction " +
      "(the single source of truth Holding, Fund and the tax summaries read income & franking from) and marks " +
      "this cash row as its matched settlement leg, so income is counted exactly once. Unlike record_income " +
      "this is a DIRECT write, NOT a Review-Queue proposal: the cash has already arrived, you are only saying " +
      "which holding it belongs to. The row must be a credit (money in) that isn't already linked to a " +
      "transaction — find candidates with list_cash_transactions (match_status \"unmatched\", category " +
      "income_* or uncategorised). Identify the holding by ticker (preferred) or holding_id, and include " +
      "franking_credits for franked dividends. Undo from the app (Detach) if you pick the wrong holding.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: z
        .number()
        .int()
        .positive()
        .describe("Bank account the cash row is on (find via list_bank_accounts)"),
      cash_transaction_id: z
        .number()
        .int()
        .positive()
        .describe("The income cash row to attribute (find via list_cash_transactions)"),
      ticker: z.string().optional().describe("Ticker of the holding that earned the income (preferred identifier)"),
      holding_id: z.number().int().positive().optional().describe("Holding ID, if already known (alternative to ticker)"),
      income_type: z
        .enum(["dividend", "distribution", "interest", "rental_income"])
        .optional()
        .describe('Income type to recognise; defaults from the row\'s category, else "dividend"'),
      franking_credits: z.number().optional().describe("Franking credits attached (AUD) — for franked dividends"),
      franking_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Franking percentage 0–100, for partially-franked dividends"),
      ex_dividend_date: isoDate("Ex-dividend date").optional(),
      payment_date: isoDate("Payment date (defaults to the cash row's posted date)").optional(),
      notes: z.string().optional()
    }
  },
  async ({ fund_id, bank_account_id, cash_transaction_id, ...attribution }) =>
    toResult(
      await api(
        "POST",
        `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/attribute`,
        { body: attribution }
      )
    )
);

server.registerTool(
  "detach_cash_transaction",
  {
    title: "Detach cash income from a holding",
    annotations: WRITES_DESTRUCTIVE,
    description:
      "Undo an attribution made with attribute_cash_transaction: discard the security transaction it " +
      "recognised and return the bank credit to the unmatched pool, so it can be re-attributed to the right " +
      "holding. Use this when income was attributed to the wrong holding or with the wrong details — detach, " +
      "then attribute_cash_transaction again. Only works on rows YOU attributed (match_status \"matched\" with " +
      "a settles_transaction_id); it will not touch auto-matched feed rows, whose transaction pre-existed, and " +
      "returns an error if the row was never attributed.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: z
        .number()
        .int()
        .positive()
        .describe("Bank account the cash row is on (find via list_bank_accounts)"),
      cash_transaction_id: z
        .number()
        .int()
        .positive()
        .describe('The attributed cash row to detach (match_status "matched", has a settles_transaction_id)')
    }
  },
  async ({ fund_id, bank_account_id, cash_transaction_id }) =>
    toResult(
      await api(
        "POST",
        `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/detach`
      )
    )
);

// ── SMSF annual return (NAT 71226) ───────────────────────────────────────────

server.registerTool(
  "get_smsf_return",
  {
    title: "Get SMSF annual return",
    annotations: READS,
    description:
      "Fetch a fund's SMSF annual return for a financial year: every section and field with its ATO label, " +
      "computed value, and whether it's calculated/readonly/confirmed, plus per-member statements and the live " +
      "gap register (what's blocking a complete return). Pass smsf_return_id from list output, or create one " +
      "first with create_smsf_return. The figures auto-fill from the ledger; edit with update_smsf_return_field.",
    inputSchema: {
      fund_id: fundId,
      smsf_return_id: z.number().int().positive().describe("SMSF return ID (from list/create)")
    }
  },
  async ({ fund_id, smsf_return_id }) =>
    toResult(await api("GET", `/funds/${fund_id}/smsf_returns/${smsf_return_id}`))
);

server.registerTool(
  "create_smsf_return",
  {
    title: "Open an SMSF annual return",
    annotations: WRITES,
    description:
      "Open (or resume) the SMSF annual return for a fund + financial year. Idempotent — returns the existing " +
      "return if one already exists for that year. Returns the full return with auto-filled figures and gaps.",
    inputSchema: {
      fund_id: fundId,
      financial_year: z.string().describe('Australian financial year label, e.g. "2023-24"')
    }
  },
  async ({ fund_id, financial_year }) =>
    toResult(await api("POST", `/funds/${fund_id}/smsf_returns`, { body: { financial_year } }))
);

server.registerTool(
  "update_smsf_return_field",
  {
    title: "Edit an SMSF return field",
    annotations: WRITES,
    description:
      "Override a single field on the return (e.g. an income or deduction amount). Goes through the same safe " +
      "write path as the web app: calculated/readonly fields are rejected, totals recompute automatically, and a " +
      "blank value reverts the field to its ledger-derived figure. Returns the recomputed return.",
    inputSchema: {
      fund_id: fundId,
      smsf_return_id: z.number().int().positive().describe("SMSF return ID"),
      section_key: z.string().describe('Section key, e.g. "income", "deductions", "tax_calc"'),
      field_key: z.string().describe('Field key within the section, e.g. "gross_rent", "auditor_fee"'),
      value: z.string().describe("New value (blank to revert to the auto/ledger value)")
    }
  },
  async ({ fund_id, smsf_return_id, section_key, field_key, value }) =>
    toResult(
      await api("PATCH", `/funds/${fund_id}/smsf_returns/${smsf_return_id}/update_field`, {
        body: { section_key, field_key, value }
      })
    )
);

server.registerTool(
  "list_smsf_return_gaps",
  {
    title: "List SMSF return gaps",
    annotations: READS,
    description:
      "List the data/functionality gaps blocking a complete, correct SMSF return (missing franking credits, EOFY " +
      "valuations, member statements, depreciation, uncategorised expenses, etc.). Each gap is tagged blocking or " +
      "advisory. Use to see what to fix before confirming sections or finalising.",
    inputSchema: {
      fund_id: fundId,
      smsf_return_id: z.number().int().positive().describe("SMSF return ID"),
      blocking_only: z.boolean().optional().describe("Only return blocking gaps")
    }
  },
  async ({ fund_id, smsf_return_id, blocking_only }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/smsf_returns/${smsf_return_id}/findings`, {
        query: { blocking: blocking_only ? "1" : undefined }
      })
    )
);

// ── Reconciliation & financial years ─────────────────────────────────────────

const bankAccountId = z
  .number()
  .int()
  .positive()
  .describe("Bank account ID (find via list_bank_accounts)");
const financialYearKey = z
  .string()
  .describe('Financial year — the label "2023-24" or its numeric id (from list_financial_years)');

server.registerTool(
  "list_financial_years",
  {
    title: "List financial years",
    annotations: READS,
    description:
      "List a fund's financial years with their status (open / closed / lodged) and close/lodge dates. " +
      "Use to find the year label to reconcile, close or lodge.",
    inputSchema: { fund_id: fundId }
  },
  async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/financial_years`))
);

server.registerTool(
  "reconcile_cash_transaction",
  {
    title: "Reconcile cash transaction",
    annotations: WRITES,
    description:
      "Tick a single cash row off against the bank statement (the line-level 'reconciled' flag, recording " +
      "that it has been checked against the official statement). Writes immediately. Rejected if the row's " +
      "financial year is already closed/lodged — reconcile before closing the year.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: bankAccountId,
      cash_transaction_id: z.number().int().positive().describe("The cash transaction to reconcile")
    }
  },
  async ({ fund_id, bank_account_id, cash_transaction_id }) =>
    toResult(
      await api(
        "POST",
        `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/reconcile`
      )
    )
);

server.registerTool(
  "unreconcile_cash_transaction",
  {
    title: "Unreconcile cash transaction",
    annotations: WRITES,
    description:
      "Remove the statement-reconciliation tick from a cash row, returning it to 'not yet checked against " +
      "the statement'. The inverse of reconcile_cash_transaction.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: bankAccountId,
      cash_transaction_id: z.number().int().positive().describe("The cash transaction to unreconcile")
    }
  },
  async ({ fund_id, bank_account_id, cash_transaction_id }) =>
    toResult(
      await api(
        "DELETE",
        `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/unreconcile`
      )
    )
);

server.registerTool(
  "record_statement_balance",
  {
    title: "Record statement balance",
    annotations: WRITES_DESTRUCTIVE,
    description:
      "Record (or correct) a bank statement's closing balance as at a date — the snapshot the year-end " +
      "balance reconciliation proves the ledger against. One snapshot per date (re-recording the same date " +
      "updates it). Use the statement's closing balance and its closing date. Amounts in AUD.",
    inputSchema: {
      fund_id: fundId,
      bank_account_id: bankAccountId,
      as_at: isoDate("Statement closing date"),
      current_balance: z.number().describe("Statement closing balance in AUD")
    }
  },
  async ({ fund_id, bank_account_id, ...statement_balance }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/bank_accounts/${bank_account_id}/record_statement_balance`, {
        body: { statement_balance }
      })
    )
);

server.registerTool(
  "run_account_reconciliation",
  {
    title: "Run account reconciliation (cash matcher)",
    annotations: WRITES,
    description:
      "Run the cash matcher over a bank account's unmatched feed rows — link settlement legs to trades/income, " +
      "pair internal transfers, and categorise cash-only events (interest, fees). Returns the match summary. " +
      "Use after recording trades/income to auto-link the matching bank rows.",
    inputSchema: { fund_id: fundId, bank_account_id: bankAccountId }
  },
  async ({ fund_id, bank_account_id }) =>
    toResult(await api("POST", `/funds/${fund_id}/bank_accounts/${bank_account_id}/reconcile`))
);

server.registerTool(
  "reconcile_financial_year",
  {
    title: "Reconcile financial year",
    annotations: WRITES,
    description:
      "Run reconciliation for a whole financial year: match cash, then compute a balance proof per bank " +
      "account (opening + movements vs the statement closing balance). Returns the balance proofs and the run " +
      "summary. Record statement balances first so accounts can reconcile rather than fall out of scope.",
    inputSchema: { fund_id: fundId, financial_year: financialYearKey }
  },
  async ({ fund_id, financial_year }) =>
    toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/reconcile`))
);

server.registerTool(
  "close_financial_year",
  {
    title: "Close financial year",
    annotations: WRITES,
    description:
      "Close a financial year — locks all dated rows in that year against further edits. Only works once " +
      "the year is reconciled (every bank account has a reconciled or out-of-scope balance proof); otherwise " +
      "returns an error explaining what's unresolved. Run reconcile_financial_year first.",
    inputSchema: { fund_id: fundId, financial_year: financialYearKey }
  },
  async ({ fund_id, financial_year }) =>
    toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/close`))
);

server.registerTool(
  "lodge_financial_year",
  {
    title: "Lodge financial year",
    annotations: WRITES,
    description:
      "Mark a closed financial year as lodged with the ATO. Only works on a closed year. Use after the SMSF " +
      "annual return has been submitted.",
    inputSchema: { fund_id: fundId, financial_year: financialYearKey }
  },
  async ({ fund_id, financial_year }) =>
    toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/lodge`))
);

server.registerTool(
  "reopen_financial_year",
  {
    title: "Reopen financial year",
    annotations: WRITES,
    description:
      "Reopen a closed financial year (back to open), unlocking its rows for edits. Only works on a closed " +
      "year — to revert a lodged year use unlodge_financial_year first.",
    inputSchema: { fund_id: fundId, financial_year: financialYearKey }
  },
  async ({ fund_id, financial_year }) =>
    toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/reopen`))
);

server.registerTool(
  "unlodge_financial_year",
  {
    title: "Unlodge financial year",
    annotations: WRITES,
    description:
      "Revert a lodged financial year back to closed (e.g. for an ATO amendment). Keeps an audit note. " +
      "Only works on a lodged year.",
    inputSchema: {
      fund_id: fundId,
      financial_year: financialYearKey,
      note: z.string().optional().describe("Reason for unlodging (kept on the year's audit note)")
    }
  },
  async ({ fund_id, financial_year, note }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/unlodge`, { body: { note } })
    )
);

server.registerTool(
  "attest_account",
  {
    title: "Attest account out of scope",
    annotations: WRITES,
    description:
      "Manually sign off a bank account for a financial year as out of scope (no feed/statement proof) so " +
      "the year can still close. Use for accounts with no statement to reconcile against.",
    inputSchema: {
      fund_id: fundId,
      financial_year: financialYearKey,
      bank_account_id: bankAccountId,
      notes: z.string().optional().describe("Why this account is out of scope")
    }
  },
  async ({ fund_id, financial_year, ...body }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/attest`, { body })
    )
);

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  if (!API_TOKEN) {
    console.error(
      "[beeswax-shares-mcp] Warning: BEESWAX_API_TOKEN is not set — tool calls will fail until it is configured."
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[beeswax-shares-mcp] connected (API: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("[beeswax-shares-mcp] fatal:", err);
  process.exit(1);
});
