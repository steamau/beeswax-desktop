import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, financialYearKey, READS, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

// 30 June (EOFY) valuations — the per-holding, per-year figures the SMSF return's
// balance sheet (item 15) and statement of financial position use, and what clears
// return gap G3. An explicit valuation (record_valuation) is the source of truth;
// update_price observations never become a year's valuation on their own.
export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "list_valuations",
    {
      title: "List 30 June valuations",
      annotations: READS,
      description:
        "List every holding the fund held at a financial year's end date (30 June) with its EOFY valuation — " +
        "the figure SMSF return item 15 and the statement of financial position use. Holdings bought after " +
        "30 June are excluded; ones sold after it are included. Each row has valued:true and the valuation " +
        "(market_value, quantity, price_per_unit, source, evidence), or valued:false with the estimate the return " +
        "falls back to and its basis (price_history = last update_price on/before 30 June × units then held; " +
        "revaluation = last revaluation transaction; current_value = today's value). Every valued:false row keeps " +
        "return gap G3 open — record one with record_valuation. Also returns unvalued_count and totals " +
        "(holdings, valued, bank_cash as at 30 June). Amounts in AUD.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("GET", `/funds/${fund_id}/financial_years/${financial_year}/valuations`))
  );

  server.registerTool(
    "record_valuation",
    {
      title: "Record a 30 June valuation",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Record (or replace) a holding's EOFY valuation for a financial year — the source of truth for its value " +
        "on the return's balance sheet; recording one for every holding held at 30 June clears gap G3. Give " +
        "EXACTLY ONE of market_value (the holding's total value in AUD, e.g. a property valuation, a fund " +
        "statement's closing balance) or price_per_unit (AUD per unit, e.g. the 30 June market close); with a " +
        "unit price the quantity is the units held at 30 June computed from the trade ledger, and market_value = " +
        "price × units. evidence is required: where the figure comes from (statement name and date, valuer, " +
        "\"ASX close 30/6/2025\"). Upserts — a second call for the same holding and year overwrites the first. " +
        "Rejected if the holding wasn't held at 30 June or the financial year is closed/lodged. A price from " +
        "update_price, even one dated 30 June, does NOT do this — call record_valuation explicitly. Returns " +
        "the valuation and unvalued_remaining (holdings still unvalued for the year).",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        holding_id: z.number().int().positive().describe("Holding to value (from list_valuations or list_holdings)"),
        market_value: z.number().nonnegative().optional().describe("Total value of the holding at 30 June, AUD"),
        price_per_unit: z.number().positive().optional().describe("Price per unit at 30 June, AUD"),
        price_date: isoDate("Date the unit price is from (default the year end)").optional(),
        source: z
          .enum(["manual", "statement", "yahoo"])
          .optional()
          .describe('"statement" (issuer/registry/fund statement), "yahoo" (market close), "manual" (default)'),
        evidence: z.string().min(1).describe("Where the figure comes from — kept for the auditor"),
        notes: z.string().optional().describe("Any further note")
      }
    },
    async ({ fund_id, financial_year, ...valuation }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/valuations`, {
          body: { valuation }
        })
      )
  );

  server.registerTool(
    "get_historical_price",
    {
      title: "Get a historical market close",
      annotations: READS,
      description:
        "Look up the Yahoo Finance end-of-day close for a LISTED ticker on a date — the close on that day, or the " +
        "last trading day before it if it didn't trade (weekend, holiday, suspension). Records nothing. Returns " +
        "symbol (e.g. MDX.AX), trade_date, close, currency, trading_days_before_requested, stale (true when the " +
        "last trade is more than 5 trading days before the date — check for a suspension or delisting) and the " +
        "evidence line to pass to record_valuation. Not for unlisted trusts, private equity or property: those " +
        "have no market price and need a statement or valuer's report.",
      inputSchema: {
        ticker: z.string().min(1).describe('Ticker without exchange suffix, e.g. "MDX" or "BHP"'),
        date: isoDate("Date to price"),
        exchange: z
          .enum(["ASX", "NZX", "LSE", "HKEX", "NYSE", "NASDAQ"])
          .optional()
          .describe("Exchange (default ASX)"),
        currency: z.string().length(3).optional().describe('Convert the close into this currency, e.g. "AUD"')
      }
    },
    async ({ ticker, date, exchange, currency }) =>
      toResult(await api("GET", "/market_prices/historical", { query: { ticker, date, exchange, currency } }))
  );

  server.registerTool(
    "snapshot_eofy_valuations",
    {
      title: "Snapshot 30 June valuations for listed holdings",
      annotations: WRITES,
      description:
        "Price every LISTED holding the fund held at a financial year's 30 June from the Yahoo Finance close on or " +
        "before that date, and record it as the year's valuation (source yahoo) with evidence naming the symbol, " +
        "trade date and fetch date (flagged STALE when the last trade is more than 5 trading days earlier). " +
        "Unlisted trusts, private equity, property and other unlisted assets are left unvalued, so gap G3 stays " +
        "open for them until record_valuation is called with real evidence. Never overwrites a valuation that " +
        "has evidence or source statement, and never a locked year. Safe to re-run. Returns result counts " +
        "(priced, failed, stale, skipped_unlisted, skipped_protected, skipped_locked) and the year's valuations " +
        "as list_valuations does.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/valuations/snapshot`))
  );
}
