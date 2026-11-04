import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, READS, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

export function register(server: McpServer, api: Api): void {
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
        "reliable quoted price. Price in AUD per unit. This does NOT set the SMSF return's 30 June " +
        "valuation (item 15) or clear gap G3, even when dated 30 June — use record_valuation for that " +
        "(a price on/before 30 June is only the return's fallback estimate until one is recorded). " +
        "Listed holdings (with a ticker) are already priced from Yahoo Finance each weekday (source \"yahoo\"), " +
        "so you rarely need this for them — a manual price on the same date as a feed close is overwritten by " +
        "the next feed run. Mainly for unlisted assets and for prices the feed can't get.",
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
}
