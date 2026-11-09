import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { bankAccountId, financialYearKey, fundId, isoDate, pageParam, perPageParam, READS, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

export function register(server: McpServer, api: Api): void {
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
        closed_on: isoDate("Last day the account was open, for an account that's already closed").optional(),
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
        gst_treatment: z
          .enum(["gst_free", "gst_inclusive", "gst_exclusive", "input_taxed"])
          .optional()
          .describe(
            "GST treatment of the line. gst_inclusive: GST is inside the amount (1/11th is stripped for the return); " +
              "gst_exclusive / gst_free / input_taxed: the amount is reported as is"
          ),
        gst_amount: z
          .number()
          .optional()
          .describe("Exact GST component in AUD, when known (overrides the 1/11th estimate)"),
        settles_fund_balance_item_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "Expense payment that settles a prior-year creditor (a liability from list_balance_items, e.g. last " +
              "year's sundry creditors): the settled part isn't an expense again. null unlinks. Same as " +
              "settle_prior_year_creditor"
          ),
        settled_balance_item_amount: z
          .number()
          .optional()
          .describe("Part of the payment that settles the creditor (default: what is still owed, capped at the payment)"),
        move_to_bank_account_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Move this row to another bank account of the fund (it was posted to the wrong one). Clears its " +
              "reconciled tick and unlinks the old account's statement lines. To move every line of a statement " +
              "uploaded to the wrong account, use move_document_to_account instead"
          ),
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
    "list_statement_balances",
    {
      title: "List statement balances",
      annotations: READS,
      description:
        "List each bank account's statement closing-balance snapshots (from posted statements or " +
        "record_statement_balance), each with the ledger balance that day and the difference (opening_anchor: true " +
        "marks the statement the day before the opening balance date, compared with opening_balance). " +
        "constant_difference is set when the ledger is out by the same amount at every statement since a date — " +
        "check the opening balance. With financial_year, also returns per account the 30 June ledger balance " +
        "the return uses (eofy.ledger_balance), the latest statement balance on or before 30 June, their " +
        "difference, and whether the account counts as return cash (ATO accounts don't). A difference that " +
        "changes between statements means the ledger is missing or has extra lines in between. AUD.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey.optional(),
        bank_account_id: bankAccountId.optional()
      }
    },
    async ({ fund_id, financial_year, bank_account_id }) =>
      toResult(
        await api("GET", `/funds/${fund_id}/bank_accounts/statement_balances`, {
          query: { financial_year, bank_account_id }
        })
      )
  );

  server.registerTool(
    "attribute_cash_transaction",
    {
      title: "Attribute cash income to a holding",
      annotations: WRITES,
      description:
        "Link an income credit already sitting on a bank account — e.g. a dividend or distribution that landed " +
        "via the bank feed — to the holding that earned it. Recognises the income on a new security transaction " +
        "(what the holding, fund and return read income and franking from) and marks this cash row as its " +
        "settlement leg, so income is counted once. Direct write. Identify the holding by ticker or holding_id; " +
        "include franking_credits for franked dividends.\n\n" +
        "Income year: pass entitlement_date when the fund was entitled to the income in an earlier year than it " +
        "was paid (e.g. a dividend paid 16 Feb 2026 that is 2024-25 income → entitlement_date 2025-06-30).\n\n" +
        "Settling a receivable: pass settles_fund_balance_item_id (an asset-side item from list_balance_items, " +
        "on the prior year's balance sheet) when the receipt pays a receivable accrued at an earlier 30 June. That " +
        "part is NOT income again; any amount received above the receivable is recorded as income (returned as " +
        "excess_income_transaction). The result shows the receivable's outstanding balance.\n\n" +
        "Re-pointing: a row already linked to a transaction is refused unless replace_existing is true. A " +
        "transaction created by an earlier attribution is then discarded; a pre-existing one (feed auto-match or " +
        "manual entry) is kept — and still counts as income — unless discard_existing_transaction is true.",
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
        entitlement_date: isoDate(
          "Date the fund became entitled to the income, when earlier than payment (sets the income year)"
        ).optional(),
        settles_fund_balance_item_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Prior-year receivable (asset balance item) this receipt settles — that part is not income"),
        settle_amount: z
          .number()
          .positive()
          .optional()
          .describe("How much of the receipt settles the receivable (default: the outstanding receivable, capped at the receipt)"),
        replace_existing: z
          .boolean()
          .optional()
          .describe("Re-point a row that is already linked to a transaction"),
        discard_existing_transaction: z
          .boolean()
          .optional()
          .describe("With replace_existing: also discard a pre-existing (not attribution-created) linked transaction"),
        franked_distribution_amount: z.number().optional().describe("Distribution tax statement: franked amount"),
        non_primary_production_amount: z.number().optional().describe("Non-primary-production income"),
        trust_franking_credit: z.number().optional().describe("Franking credits passed through by the trust"),
        foreign_income_amount: z.number().optional().describe("Assessable foreign income"),
        foreign_tax_paid: z.number().optional().describe("Foreign income tax offset"),
        capital_gain_discounted_gross: z.number().optional().describe("Discounted capital gain, grossed up"),
        capital_gain_indexed: z.number().optional().describe("Indexed capital gain"),
        capital_gain_other: z.number().optional().describe("Other capital gain"),
        cgt_concession_amount: z.number().optional().describe("CGT concession amount"),
        tax_deferred_amount: z.number().optional().describe("Tax-deferred (AMIT cost-base decrease) amount"),
        amit_cost_base_increase: z.number().optional().describe("AMIT cost-base increase"),
        gst_treatment: z.enum(["gst_free", "gst_inclusive", "gst_exclusive", "input_taxed"]).optional(),
        gst_amount: z.number().optional(),
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
    "split_cash_transaction",
    {
      title: "Split a cash row into categorised parts",
      annotations: WRITES,
      description:
        "Split one cash row into two or more parts that add up to it exactly, each with its own category — e.g. " +
        "an ATO credit of $336 that is a $308.73 refund (tax_refund) plus $27.27 interest on overpayment " +
        "(income_bank_interest, assessable). The original row becomes part 1 (same id, statement links and " +
        "reconciliation tick); the other parts are new rows on the same date with the same tick, external_ref " +
        "\"<original ref>:split:<n>\". Audit-logged with your reasoning. Refused for a locked year, a row linked " +
        "to an income transaction, cost or counter-transfer (detach first), a row with a GST amount, or parts " +
        "that don't sum to the original. Signed amounts like the original (+ in / − out), AUD.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: z.number().int().positive().describe("Bank account the cash row is on"),
        cash_transaction_id: z.number().int().positive().describe("The cash row to split"),
        parts: z
          .array(
            z.object({
              amount: z.number().describe("Signed amount of this part"),
              category: z.string().describe('Cash category, e.g. "tax_refund", "income_bank_interest"'),
              description: z.string().optional().describe("Defaults to the original's description + (part n of N)"),
              fund_member_id: z.number().int().positive().optional().describe("For a contribution part"),
              contribution_type: z.string().optional(),
              tax_component: z.string().optional()
            })
          )
          .min(2)
          .describe("The parts; amounts must sum to the original row's amount")
      }
    },
    async ({ fund_id, bank_account_id, cash_transaction_id, parts }) =>
      toResult(
        await api(
          "POST",
          `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/split`,
          { body: { parts } }
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

  server.registerTool(
    "settle_prior_year_creditor",
    {
      title: "Link an expense payment to a prior-year creditor",
      annotations: WRITES,
      description:
        "Say that an expense payment settles a creditor carried on an earlier year's balance sheet (a liability " +
        "balance item, e.g. FY24 \"Sundry creditors\" for accounting and audit fees paid in FY25). That part was " +
        "the earlier year's expense, so the operating statement and the return's deductions leave it out — no H1/J1 " +
        "override needed. amount defaults to what is still owed on the creditor, capped at the payment; several " +
        "payments can settle one creditor. fund_balance_item_id null unlinks. The result gives the row's " +
        "expense_amount before → after and what is still owed. Blocked if the payment's year is closed or lodged.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: bankAccountId,
        cash_transaction_id: z.number().int().positive().describe("The expense payment (from list_cash_transactions)"),
        fund_balance_item_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe("The prior-year liability it settles (list_balance_items), or null to unlink"),
        amount: z.number().positive().optional().describe("Part of the payment that settles it (default: what is still owed)")
      }
    },
    async ({ fund_id, bank_account_id, cash_transaction_id, fund_balance_item_id, amount }) =>
      toResult(
        await api(
          "POST",
          `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/settle_creditor`,
          { body: { fund_balance_item_id, amount } }
        )
      )
  );

  server.registerTool(
    "set_expense_gst_treatment",
    {
      title: "Expenses' GST vs BAS credits, and a bulk GST fix",
      annotations: WRITES,
      description:
        "Compare a year's expense GST with the GST credits claimed on the activity statements (per period: GST on " +
        "rent − net GST raised on the imported 001 account), and set the GST treatment on the year's expense rows " +
        "in one go. dry_run (default true) changes nothing: it lists each row it would change (gst_treatment, GST and " +
        "expense_amount before → after), the ledger GST after the change against credits_claimed, and the expense " +
        "change. Without cash_transaction_ids it takes every gst_free expense row with no gst_amount in a category " +
        "that carries GST (not bank fees, ASIC fees, interest or insurance) — or the categories given. Show the " +
        "preview to the user and apply (dry_run: false) only when they say so. The expenses_gst_treatment check " +
        "reports the same comparison.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        gst_treatment: z
          .enum(["gst_inclusive", "gst_free", "gst_exclusive", "input_taxed"])
          .optional()
          .describe("Treatment to set (default gst_inclusive)"),
        cash_transaction_ids: z.array(z.number().int().positive()).optional().describe("Only these expense rows"),
        categories: z
          .array(z.string())
          .optional()
          .describe('Only gst_free rows in these expense categories, e.g. ["expense_accounting", "expense_audit"]'),
        dry_run: z.boolean().optional().describe("Default true: preview only")
      }
    },
    async ({ fund_id, financial_year, ...body }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/expense_gst`, {
          body: { ...body, dry_run: body.dry_run ?? true }
        })
      )
  );
}
