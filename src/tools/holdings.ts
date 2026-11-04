import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

export function register(server: McpServer, api: Api): void {
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
        share_registry: z
          .string()
          .optional()
          .describe(
            'Share registry: "computershare", "mufg" (MUFG Corporate Markets, formerly Link Market Services), ' +
              '"automic", "boardroom", "advanced", "xcend" or "other". Left out, it is looked up from the ticker when one is on file.'
          ),
        notes: z.string().optional()
      }
    },
    async ({ fund_id, ...holding }) =>
      toResult(await api("POST", `/funds/${fund_id}/holdings`, { body: { holding } }))
  );

  server.registerTool(
    "update_holding",
    {
      title: "Update holding",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Edit an existing holding's fields — most usefully to correct a property (or other lump-sum " +
        "asset's) cost base via purchase_price, or to fix metadata such as a ticker, name, exchange, " +
        "acquisition date, sector or status. Find the holding via list_holdings; only supply the fields " +
        "you want to change. IMPORTANT: for equities that have a buy/sell trade history, cost base and " +
        "quantity are derived from the trade ledger, so purchase_price / purchase_price_per_unit / " +
        "quantity set here are IGNORED for them — adjust the underlying trades with record_trade instead. " +
        "For property and other quantity-less lump-sum assets, cost base = purchase_price plus any " +
        "stamp_duty / legal_fees / broker_fee_buy / other_purchase_costs. The edit is audited. Amounts in " +
        "AUD unless currency says otherwise.",
      inputSchema: {
        fund_id: fundId,
        holding_id: z.number().int().positive().describe("Holding to edit (find via list_holdings)"),
        name: z.string().optional().describe("Security/asset name"),
        ticker_symbol: z.string().optional().describe('Ticker, e.g. "VAS"'),
        exchange: z.string().optional().describe('Exchange, e.g. "ASX"'),
        asset_type: z
          .string()
          .optional()
          .describe('Asset type by name or category, e.g. "ETF" or "equity" (see list_asset_types)'),
        broker_id: z.number().int().positive().optional().describe("Broker ID (see list_brokers)"),
        hin: z.string().optional().describe("Holder Identification Number"),
        share_registry: z
          .string()
          .optional()
          .describe(
            'Share registry: "computershare", "mufg" (MUFG Corporate Markets, formerly Link Market Services), ' +
              '"automic", "boardroom", "advanced", "xcend" or "other". Left out, it is looked up from the ticker when one is on file.'
          ),
        acquisition_date: isoDate("Acquisition date").optional(),
        quantity: z
          .number()
          .optional()
          .describe("Units held (ignored for equities with a trade history)"),
        purchase_price_per_unit: z
          .number()
          .optional()
          .describe("Purchase price per unit in AUD (ignored for equities with a trade history)"),
        purchase_price: z
          .number()
          .optional()
          .describe(
            "Total purchase price in AUD — drives cost base for property and other lump-sum (quantity-less) assets"
          ),
        face_value: z
          .number()
          .optional()
          .describe("Face value in AUD (cost base driver for fixed-income holdings)"),
        broker_fee_buy: z.number().optional().describe("Acquisition brokerage in AUD (adds to cost base)"),
        stamp_duty: z.number().optional().describe("Stamp duty on acquisition in AUD (adds to cost base)"),
        legal_fees: z.number().optional().describe("Legal fees on acquisition in AUD (adds to cost base)"),
        other_purchase_costs: z
          .number()
          .optional()
          .describe("Other acquisition costs in AUD (adds to cost base)"),
        current_price_per_unit: z.number().optional().describe("Current price per unit in AUD"),
        current_price_date: isoDate("Date of the current price").optional(),
        currency: z.string().optional().describe('Currency code (default "AUD")'),
        sector: z.string().optional().describe("Sector classification"),
        status: z.string().optional().describe('Holding status, e.g. "active" or "sold"'),
        notes: z.string().optional()
      }
    },
    async ({ fund_id, holding_id, ...holding }) =>
      toResult(await api("PATCH", `/funds/${fund_id}/holdings/${holding_id}`, { body: { holding } }))
  );
}
