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
    throw new Error(
      `Could not reach the Beeswax Shares API at ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`
    );
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
    throw new Error(`Beeswax API error (HTTP ${res.status}): ${apiError}`);
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

/** Format an API response as MCP text content, appending pagination info when present. */
function toResult(response: ApiResponse) {
  let payload: unknown = response.body;
  if (
    response.pagination &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    payload = { ...(payload as Record<string, unknown>), pagination: response.pagination };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
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

const server = new McpServer({
  name: "beeswax-shares",
  version: "1.0.0"
});

server.registerTool(
  "whoami",
  {
    title: "Who am I",
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
      })
    )
);

server.registerTool(
  "create_holding",
  {
    title: "Create holding",
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
    title: "Record trade (proposal)",
    description:
      "Propose a buy or sell for your SMSF ledger. This does NOT write to the ledger directly — it " +
      "creates a PENDING PROPOSAL that you approve or reject in the app's Review Queue. Use whenever a " +
      "trade is found in an email, contract note or conversation. Identify the holding by ticker or " +
      "holding_id (if neither matches, the proposal is stored unmapped and resolved at review). Always pass " +
      "external_ref when the source has a stable ID (e.g. email message id + ticker + date) — it is an " +
      "idempotency key, so re-running the same import will not create duplicates. Set confidence and " +
      "reasoning so the reviewer can judge the proposal. Amounts in AUD unless currency says otherwise.",
    inputSchema: {
      fund_id: fundId,
      transaction_type: z.enum(["buy", "sell"]).describe("Trade direction"),
      transaction_date: isoDate("Trade date"),
      ticker: z.string().optional().describe("Ticker symbol of the holding (preferred way to identify it)"),
      holding_id: z.number().int().positive().optional().describe("Holding ID, if already known"),
      security_name: z.string().optional().describe("Security name as it appears in the source document"),
      quantity: z.number().optional().describe("Units bought/sold"),
      price_per_unit: z.number().optional().describe("Price per unit"),
      total_amount: z.number().describe("Total consideration (AUD unless currency set)"),
      broker_fee: z.number().optional().describe("Brokerage fee"),
      currency: z.string().optional().describe('Currency code (default "AUD")'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Your confidence in the extracted data, 0–1"),
      reasoning: z.string().optional().describe("Why you believe this trade occurred (cite the source)"),
      notes: z.string().optional(),
      external_ref: z
        .string()
        .optional()
        .describe("Idempotency key derived from the source, e.g. '<email-message-id>:VAS:2026-05-30'")
    }
  },
  async ({ fund_id, external_ref, ...proposed_transaction }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/proposed_transactions`, {
        body: { proposed_transaction, external_ref }
      })
    )
);

server.registerTool(
  "record_income",
  {
    title: "Record income (proposal)",
    description:
      "Propose an income event — dividend, distribution, interest or rental income — for your SMSF " +
      "ledger. Like record_trade, this creates a PENDING PROPOSAL for human review in the app's Review " +
      "Queue; it never writes to the ledger directly. Use when a dividend statement, distribution advice or " +
      "rent receipt is found. Include franking_credits for franked dividends (important for SMSF tax). " +
      "Always pass external_ref when the source has a stable ID so repeat imports are idempotent. All " +
      "amounts AUD unless currency says otherwise.",
    inputSchema: {
      fund_id: fundId,
      transaction_type: z
        .enum(["dividend", "distribution", "interest", "rental_income"])
        .describe("Income type"),
      transaction_date: isoDate("Income date (usually the payment date)"),
      ticker: z.string().optional().describe("Ticker symbol of the holding (preferred way to identify it)"),
      holding_id: z.number().int().positive().optional().describe("Holding ID, if already known"),
      security_name: z.string().optional().describe("Security name as it appears in the source document"),
      total_amount: z.number().describe("Cash amount received (AUD unless currency set)"),
      franking_credits: z
        .number()
        .optional()
        .describe("Franking credits attached (AUD) — for franked dividends"),
      payment_date: isoDate("Payment date").optional(),
      ex_dividend_date: isoDate("Ex-dividend date").optional(),
      currency: z.string().optional().describe('Currency code (default "AUD")'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Your confidence in the extracted data, 0–1"),
      reasoning: z.string().optional().describe("Why you believe this income occurred (cite the source)"),
      notes: z.string().optional(),
      external_ref: z
        .string()
        .optional()
        .describe("Idempotency key derived from the source, e.g. '<email-message-id>:VAS:2026-03-28'")
    }
  },
  async ({ fund_id, external_ref, ...proposed_transaction }) =>
    toResult(
      await api("POST", `/funds/${fund_id}/proposed_transactions`, {
        body: { proposed_transaction, external_ref }
      })
    )
);

server.registerTool(
  "list_pending_proposals",
  {
    title: "List pending proposals",
    description:
      "List proposed transactions awaiting review in the app's Review Queue (default status " +
      "'pending'). Use after record_trade / record_income / document uploads to show what is queued, or to " +
      "avoid proposing something that is already pending. Approval/rejection happens in the app, not here.",
    inputSchema: {
      fund_id: fundId,
      status: z
        .string()
        .optional()
        .describe('Proposal status filter (default "pending"; also "approved", "rejected")'),
      page: pageParam,
      per_page: perPageParam
    }
  },
  async ({ fund_id, status, page, per_page }) =>
    toResult(
      await api("GET", `/funds/${fund_id}/proposed_transactions`, {
        query: { status: status ?? "pending", page, per_page }
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
      })
    );
  }
);

server.registerTool(
  "get_document",
  {
    title: "Get document",
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
    toResult(await api("GET", `/funds/${fund_id}/documents/${document_id}`))
);

server.registerTool(
  "list_documents",
  {
    title: "List documents",
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
      await api("GET", `/funds/${fund_id}/documents`, { query: { status, page, per_page } })
    )
);

server.registerTool(
  "reconcile_document",
  {
    title: "Reconcile document",
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
    toResult(await api("POST", `/funds/${fund_id}/documents/${document_id}/reconcile`))
);

server.registerTool(
  "record_cost",
  {
    title: "Record cost entry",
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
    description:
      "List the asset types supported by Beeswax Shares (name, category, and whether the type carries " +
      "tickers, dividends or franking credits). Use to pick a valid asset_type for create_holding or to " +
      "understand the fund's asset allocation categories.",
    inputSchema: {}
  },
  async () => toResult(await api("GET", "/asset_types"))
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
