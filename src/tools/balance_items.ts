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

  server.registerTool(
    "apply_ato_balance_items",
    {
      title: "Link balance items to the ATO accounts",
      annotations: WRITES,
      description:
        "Take a financial year's ATO balance-sheet lines from the fund's imported ATO accounts instead of typing " +
        "them: the activity statement's integrated client account (bucket \"ica\"), the quarter's GST and PAYG " +
        "instalment accrued at 30 June (buckets \"gst\", \"payg_instalment\"), and the income tax / super " +
        "accounts, each at its 30 June position (get_ato_position). Written lines have source \"ato_position\" " +
        "with their ato_account_id + ato_bucket and follow later imports when applied again. Pass replace with the " +
        "ids of typed lines (list_balance_items) they stand in for, to discard those in the same step. dry_run " +
        "defaults to true: it returns the lines it would write (with the recorded line each updates), the derived " +
        "lines it would drop and the typed lines it would replace, and writes nothing. Show the user, then call " +
        "again with dry_run: false. Rejected if the year is closed or lodged.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        replace: z.array(z.number().int()).optional().describe("Ids of typed balance items these lines replace"),
        dry_run: z.boolean().default(true).describe("true (default): preview only, nothing written")
      }
    },
    async ({ fund_id, financial_year, replace, dry_run }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/balance_items/ato_position`, {
          body: { replace: replace ?? [], dry_run: dry_run !== false }
        })
      )
  );

  server.registerTool(
    "get_tax_position",
    {
      title: "Get the year's tax position",
      annotations: READS,
      description:
        "Read a financial year's tax position — the facts the ledger can't derive that feed the return's losses " +
        "schedule and calculation statement: prior_year_capital_loss_bf, net_capital_loss_cf, tax_losses_bf, " +
        "paygi_instalments_raised (item 13 K), supervisory_levy (L), tfn_withholding_credit (H), " +
        "no_tfn_contributions_tax (J), ecpi_method and actuarial_percentage. recorded:false means none is " +
        "saved yet (the review's tax_position_recorded check stays red). Amounts in AUD.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("GET", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/tax_position`))
  );

  server.registerTool(
    "update_tax_position",
    {
      title: "Record the year's tax position",
      annotations: WRITES,
      description:
        "Create or update a financial year's tax position; only the fields you pass change. Feeds the return's " +
        "losses schedule and calculation statement and clears the review checks tax_position_recorded and " +
        "capital_losses_brought_forward when the figures agree with last year's return. A new position defaults " +
        "the supervisory levy to the year's rate. Refused for a closed or lodged year. The fund's TFN is not part " +
        "of the tax position and can't be set through the API — the trustee enters it on the web. AUD.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        prior_year_capital_loss_bf: z.number().nonnegative().optional().describe("Net capital losses brought forward from prior years"),
        net_capital_loss_cf: z.number().nonnegative().optional().describe("Net capital losses carried forward to later years"),
        tax_losses_bf: z.number().nonnegative().optional().describe("Tax losses brought forward"),
        paygi_instalments_raised: z.number().nonnegative().optional().describe("PAYG instalments raised for the year (13 K)"),
        supervisory_levy: z.number().nonnegative().optional().describe("Supervisory levy (13 L)"),
        tfn_withholding_credit: z.number().nonnegative().optional().describe("Credit for TFN amounts withheld (13 H)"),
        no_tfn_contributions_tax: z.number().nonnegative().optional().describe("Tax on no-TFN-quoted contributions (13 J)"),
        ecpi_method: z.enum(["none", "segregated", "unsegregated"]).optional().describe("Exempt current pension income method"),
        actuarial_percentage: z.number().min(0).max(100).optional().describe("Actuarial certificate exempt %, unsegregated method")
      }
    },
    async ({ fund_id, financial_year, ...fields }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/tax_position`, {
          body: { tax_position: fields }
        })
      )
  );
}
