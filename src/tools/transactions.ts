import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, WRITES, WRITES_DESTRUCTIVE } from "../shared.js";

const amount = (what: string) => z.number().optional().describe(`${what} (AUD)`);

// Tax-statement, GST and accrual fields shared by record_income and
// update_transaction. All optional; AUD.
const incomeTaxFields = {
  franking_credits: amount("Franking credits attached to a dividend"),
  franking_percentage: z.number().min(0).max(100).optional().describe("Percentage of a dividend that is franked (0–100)"),
  franked_distribution_amount: amount(
    "Trust distribution: franked distributions (grossed up), from the annual tax statement — item 11 M"
  ),
  non_primary_production_amount: amount(
    "Trust distribution: non-primary-production income (unfranked / interest / other Australian income) — item 11 M"
  ),
  trust_franking_credit: amount("Trust distribution: franking credits passed through — 13 E1 offset"),
  foreign_income_amount: amount("Assessable foreign income (gross, before foreign tax) — item 11 D"),
  foreign_tax_paid: amount("Foreign income tax paid / withheld — 13 C1 offset"),
  capital_gain_discounted_gross: amount(
    "Trust distribution: discount-method capital gains GROSSED UP (the discounted gain plus the CGT concession amount) — CGT schedule 1 G, discountable"
  ),
  capital_gain_indexed: amount("Trust distribution: indexation-method capital gains — 1 G, not discountable"),
  capital_gain_other: amount("Trust distribution: other-method capital gains — 1 G, not discountable"),
  cgt_concession_amount: amount(
    "Trust distribution: CGT concession amount (the trust's discount; non-assessable, recorded for reference)"
  ),
  tax_deferred_amount: amount(
    "Trust distribution: tax-deferred amount / AMIT cost-base net decrease — reduces the holding's cost base"
  ),
  amit_cost_base_increase: amount("Trust distribution: AMIT cost-base net increase — increases the holding's cost base"),
  gst_treatment: z
    .enum(["gst_free", "gst_inclusive", "gst_exclusive", "input_taxed"])
    .optional()
    .describe(
      "GST treatment (rent especially). gst_inclusive: total_amount includes GST and is reported GST-exclusive; " +
        "the others report total_amount as is. Setting any value clears gap G11 for rent"
    ),
  gst_amount: amount("Exact GST included in total_amount, when known (overrides the 1/11th estimate)"),
  entitlement_date: isoDate(
    "Date the fund became entitled to the income (e.g. 30 June for a distribution declared for the year but paid in July). " +
      "Decides the financial year the income is taxed in; defaults to transaction_date"
  ).optional(),
  settles_fund_balance_item_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Balance item ID (list_balance_items) of the PRIOR-YEAR receivable this receipt collects. The receipt is then " +
        "excluded from this year's income, because it was income of the earlier year"
    ),
  rental_period_from: isoDate("Rent: period start").optional(),
  rental_period_to: isoDate("Rent: period end").optional(),
  tenant_name: z.string().optional().describe("Rent: tenant name")
};

export function register(server: McpServer, api: Api): void {
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
        "distribution advice, annual tax statement or rent receipt is found. Identify the holding by ticker or " +
        "holding_id (it must already exist). Include franking_credits for franked dividends. For a trust " +
        "distribution enter the annual tax statement split (franked / non-primary-production / trust franking " +
        "credit / foreign income / capital gains / tax-deferred) — the return uses the components, not the cash. " +
        "For income the fund was entitled to in an earlier year, pass entitlement_date (accrual), or " +
        "settles_fund_balance_item_id when the earlier year recorded it as a receivable. For rent set gst_treatment. " +
        "Always pass external_ref when the source has a stable ID so repeat imports are idempotent. Pass reasoning " +
        "to record why (saved for the audit trail). All amounts AUD unless currency says otherwise.",
      inputSchema: {
        fund_id: fundId,
        transaction_type: z
          .enum(["dividend", "distribution", "interest", "rental_income"])
          .describe("Income type"),
        transaction_date: isoDate("Income date (usually the payment date)"),
        ticker: z.string().optional().describe("Ticker symbol of the holding (preferred way to identify it)"),
        holding_id: z.number().int().positive().optional().describe("Holding ID, if already known"),
        total_amount: z.number().describe("Cash amount received (AUD unless currency set)"),
        payment_date: isoDate("Payment date").optional(),
        ex_dividend_date: isoDate("Ex-dividend date").optional(),
        ...incomeTaxFields,
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

  server.registerTool(
    "update_transaction",
    {
      title: "Update a ledger transaction",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Edit an existing security-ledger transaction (trade or income) in place — e.g. add a distribution's " +
        "annual tax statement components, set rent's GST treatment, set an entitlement date to accrue income to " +
        "an earlier year, link a receipt to the prior-year receivable it settles, or enter a sell's capital gain. " +
        "Only the fields you pass change; this overwrites them. Find the row via search_transactions (it gives " +
        "the id and holding_id). Blocked if the transaction's financial year is closed or lodged. AUD.",
      inputSchema: {
        fund_id: fundId,
        holding_id: z.number().int().positive().describe("Holding the transaction belongs to"),
        transaction_id: z.number().int().positive().describe("Transaction ID (from search_transactions)"),
        transaction_date: isoDate("New transaction date").optional(),
        total_amount: z.number().optional().describe("New total amount (AUD unless currency set)"),
        quantity: z.number().optional().describe("Units"),
        price_per_unit: z.number().optional(),
        broker_fee: z.number().optional(),
        payment_date: isoDate("Payment date").optional(),
        ex_dividend_date: isoDate("Ex-dividend date").optional(),
        ...incomeTaxFields,
        capital_gain_loss: z
          .number()
          .optional()
          .describe("Sell: capital gain (+) or loss (−) from the tax statement — taken as given on the CGT schedule"),
        cgt_discount_eligible: z.boolean().optional().describe("Sell: whether the gain is discountable (held 12+ months)"),
        cgt_discount_amount: amount("Sell: CGT discount amount, for reference"),
        cost_base: amount("Sell: cost base of the units sold"),
        notes: z.string().optional()
      }
    },
    async ({ fund_id, holding_id, transaction_id, ...transaction }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/holdings/${holding_id}/transactions/${transaction_id}`, {
          body: { transaction }
        })
      )
  );
}
