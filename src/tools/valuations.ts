import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, financialYearKey, READS, WRITES_DESTRUCTIVE } from "../shared.js";

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
}
