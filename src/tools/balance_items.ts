import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, WRITES, WRITES_DESTRUCTIVE, financialYearKey, balanceItemId } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "list_balance_items",
    {
      title: "List balance-sheet items",
      annotations: READS,
      description:
        "List the trustee-entered balance-sheet lines for a financial year — the figures the investment ledger " +
        "can't derive: other assets (receivables, non-holding plant), borrowings (LRBAs and other loans) and " +
        "other liabilities (ATO accounts, GST, creditors, rent bonds). These feed SMSF return items 15b O, 16 V " +
        "and 16 Y and the statement of financial position. Returns per-side totals alongside the rows.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        side: z.enum(["asset", "liability"]).optional().describe("Filter by balance-sheet side"),
        kind: z
          .enum(["other", "borrowings"])
          .optional()
          .describe('Filter liabilities: "borrowings" (16 V) or "other" (16 Y)')
      }
    },
    async ({ fund_id, financial_year, side, kind }) =>
      toResult(
        await api("GET", `/funds/${fund_id}/financial_years/${financial_year}/balance_items`, {
          query: { side, kind }
        })
      )
  );

  server.registerTool(
    "record_balance_item",
    {
      title: "Record a balance-sheet item",
      annotations: WRITES,
      description:
        "Record a balance-sheet line the ledger can't derive, as at a financial year's end — a receivable, an " +
        "LRBA/loan balance still owed, an ATO account, GST, a creditor or a rent bond. Amounts are POSITIVE " +
        "magnitudes on the stated side (a $118,991.97 loan owed is side \"liability\", kind \"borrowings\", " +
        "amount 118991.97). Use kind \"borrowings\" ONLY for money borrowed (it lands at ATO item 16 V); every " +
        "other liability is kind \"other\" (16 Y). Rejected if the financial year is already closed or lodged.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        side: z.enum(["asset", "liability"]).describe("Balance-sheet side"),
        label: z.string().describe('Line description, e.g. "NAB LRBA loan 19-412-5863"'),
        amount: z.number().describe("Amount in AUD as a positive magnitude on the stated side"),
        kind: z
          .enum(["other", "borrowings"])
          .optional()
          .describe('Liability box: "borrowings" (16 V) or "other" (16 Y, the default)'),
        position: z.number().int().optional().describe("Display order within the side")
      }
    },
    async ({ fund_id, financial_year, ...item }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/balance_items`, {
          body: { fund_balance_item: item }
        })
      )
  );

  server.registerTool(
    "update_balance_item",
    {
      title: "Correct a balance-sheet item",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Correct an existing balance-sheet line (amount, label, side, kind or display order). Only the fields you " +
        "pass are changed. Rejected if the financial year is already closed or lodged.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        balance_item_id: balanceItemId,
        side: z.enum(["asset", "liability"]).optional(),
        kind: z.enum(["other", "borrowings"]).optional(),
        label: z.string().optional(),
        amount: z.number().optional().describe("Amount in AUD as a positive magnitude"),
        position: z.number().int().optional()
      }
    },
    async ({ fund_id, financial_year, balance_item_id, ...item }) =>
      toResult(
        await api(
          "PATCH",
          `/funds/${fund_id}/financial_years/${financial_year}/balance_items/${balance_item_id}`,
          { body: { fund_balance_item: item } }
        )
      )
  );

  server.registerTool(
    "delete_balance_item",
    {
      title: "Remove a balance-sheet item",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Soft-delete a balance-sheet line so it stops feeding the return and financial statements. Rejected if the " +
        "financial year is already closed or lodged.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        balance_item_id: balanceItemId
      }
    },
    async ({ fund_id, financial_year, balance_item_id }) =>
      toResult(
        await api(
          "DELETE",
          `/funds/${fund_id}/financial_years/${financial_year}/balance_items/${balance_item_id}`
        )
      )
  );
}
