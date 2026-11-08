import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, READS, WRITES, WRITES_DESTRUCTIVE, financialYearKey, bankAccountId } from "../shared.js";

// Workstream D — fund admin: fund details (return Section A / K), bank-account
// details and opening balances, and depreciation (item 12 D1/E1).

const holdingId = z.number().int().positive().describe("Holding ID (find via list_holdings)");
const scheduleId = z
  .number()
  .int()
  .positive()
  .describe("Depreciation schedule ID (from list_depreciation_schedules)");

const contactFields = {
  firm_name: z.string().optional().describe("Firm / practice name"),
  email: z.string().optional(),
  phone: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional().describe("State, e.g. NSW"),
  postcode: z.string().optional()
};

const auditorSchema = z
  .object({
    name: z.string().optional().describe("Auditor's name (required when adding a new auditor)"),
    smsf_auditor_number: z.string().optional().describe("SMSF auditor number (SAN), 9 digits"),
    ...contactFields
  })
  .describe(
    "The fund's approved SMSF auditor (return item 6). Matched to an existing auditor by SAN, then by name; " +
      "otherwise created. Contact details passed here update that auditor's record."
  );

const taxAgentSchema = z.union([
  z.literal("none").describe('"none" — no tax agent; the trustees lodge the return themselves'),
  z
    .object({
      name: z.string().optional().describe("Tax agent's name (required when adding a new agent)"),
      agent_number: z.string().optional().describe("Registered tax agent number"),
      ...contactFields
    })
    .describe("Registered tax agent who prepares and lodges the return (Section K declaration)")
]);

const divisionEnum = z
  .enum(["div43", "div40"])
  .describe('"div43" capital works (building/structural, item 12 D1) or "div40" plant & equipment (item 12 E1)');
const methodEnum = z
  .enum(["capital_works", "prime_cost", "diminishing_value"])
  .describe(
    'Div 43 always uses "capital_works" (the default). Div 40: "prime_cost" (cost × days/365 × 100%/life) or ' +
      '"diminishing_value" (opening adjustable value × days/365 × 200%/life). Defaults to prime_cost for div40.'
  );

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "update_fund_details",
    {
      title: "Update fund details (ABN, auditor, tax agent)",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Set the fund details the SMSF annual return prints: ABN (item 3; spaces are stripped and the ATO " +
        "checksum is enforced), establishment date, postal address, electronic service address alias, the SMSF " +
        "auditor with SAN and contact details (item 6), and the tax agent with agent number — or tax_agent " +
        '"none" when the trustees self-lodge (Section K declarations). Pass financial_year to also record the ' +
        "auditor on that year's audit engagement (refused for a closed/lodged year); without it the auditor " +
        "becomes the fund's standing appointment, used for any year whose engagement names none. Only the " +
        "fields you pass change. The fund's TFN can NOT be set here — it is entered by the trustee on the web.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey.optional().describe(
          'Year whose audit engagement should name this auditor, e.g. "2024-25"'
        ),
        name: z.string().optional().describe("Fund name as registered"),
        abn: z.string().optional().describe("Australian business number, 11 digits (spaces allowed)"),
        establishment_date: isoDate("Date the fund was established (the return's 5 C first-return answer comes from it)").optional(),
        wound_up_on: isoDate("Date the fund was wound up, if it has been (the return's item 9 comes from it)").optional(),
        esa_alias: z.string().optional().describe("Electronic service address alias (item 7 C)"),
        postal_address_line1: z.string().optional(),
        postal_address_line2: z.string().optional(),
        postal_suburb: z.string().optional(),
        postal_state: z.string().optional(),
        postal_postcode: z.string().optional(),
        auditor: auditorSchema.optional(),
        tax_agent: taxAgentSchema.optional()
      }
    },
    async ({ fund_id, ...fund }) => toResult(await api("PATCH", `/funds/${fund_id}`, { body: { fund } }))
  );

  server.registerTool(
    "update_bank_account",
    {
      title: "Correct a bank account and its opening balance",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Correct a bank account's name, institution, BSB, account number, account holder, status, notes, or its " +
        "opening balance. opening_balance (AUD) is the balance at the START of opening_balance_date: cash " +
        "transactions dated before that day are excluded from the ledger (the result reports how many, as " +
        "pre_opening_transaction_count/_total, so they can be reviewed), and the account contributes 0 to any " +
        "balance as at an earlier date. Use it to anchor the ledger to an audited closing balance — e.g. a " +
        "30/6/24 audited balance of $163.93 is opening_balance 163.93 with opening_balance_date 2024-07-01. " +
        "Refused if the change would move the closing balance of a closed or lodged financial year (reopen " +
        "that year first). Only the fields you pass change.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: bankAccountId,
        name: z.string().optional(),
        institution_name: z.string().optional(),
        bsb: z.string().optional().describe('BSB, e.g. "082-001"'),
        account_number: z.string().optional().describe("Account number (stored encrypted)"),
        account_holder_name: z.string().optional(),
        opening_balance: z.number().optional().describe("Balance in AUD at the start of opening_balance_date"),
        opening_balance_date: isoDate("Date the opening balance applies from").optional(),
        account_role: z.enum(["operating", "term_deposit", "pension", "contributions", "ato"]).optional(),
        status: z.enum(["active", "inactive", "closed"]).optional(),
        closed_on: isoDate(
          "Last day the account was open. Closes it (status becomes closed); the ledger can't hold movements " +
            "after it. Later years drop the account; the year it closed in proves a nil 30 June balance. " +
            "Reopen by setting status active."
        ).optional(),
        notes: z.string().optional()
      }
    },
    async ({ fund_id, bank_account_id, ...bank_account }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/bank_accounts/${bank_account_id}`, { body: { bank_account } })
      )
  );

  server.registerTool(
    "list_depreciation_schedules",
    {
      title: "List depreciation schedules",
      annotations: READS,
      description:
        "List the fund's depreciation schedules — Div 43 capital works (item 12 D1) and Div 40 plant such as an " +
        "air conditioner (item 12 E1) — with each schedule's cost base, start date, effective life / rate and " +
        "its calculated per-year entries (deductible amount and closing adjustable value, AUD). Pass " +
        "financial_year to see only that year's entry per schedule plus the year's D1/E1 totals.",
      inputSchema: {
        fund_id: fundId,
        holding_id: holdingId.optional().describe("Only this holding's schedules"),
        financial_year: financialYearKey.optional()
      }
    },
    async ({ fund_id, holding_id, financial_year }) => {
      const schedules = await api("GET", `/funds/${fund_id}/depreciation_schedules`, {
        query: { holding_id, financial_year }
      });
      if (!financial_year) return toResult(schedules);
      const year = await api("GET", `/funds/${fund_id}/financial_years/${financial_year}/depreciation`);
      return toResult({
        body: { ...(schedules.body as object), year: year.body },
        pagination: schedules.pagination
      });
    }
  );

  server.registerTool(
    "create_depreciation_schedule",
    {
      title: "Add a depreciation schedule",
      annotations: WRITES,
      description:
        "Add a depreciation schedule to a holding (usually a property). Div 43 capital works: cost_base is the " +
        "construction cost, deducted at 2.5% a year (override with rate) pro-rated from start_date. Div 40 " +
        "plant & equipment: cost_base is the asset's cost, with effective_life_years (ATO effective life) or an " +
        "explicit annual rate; prime_cost or diminishing_value. For an asset already part-written-down when " +
        "tracking starts, set start_date to the first day tracked and opening_adjustable_value to its written-" +
        "down value then. Run calculate_depreciation afterwards to generate the year's entry for the return.",
      inputSchema: {
        fund_id: fundId,
        holding_id: holdingId,
        division: divisionEnum,
        method: methodEnum.optional(),
        description: z.string().optional().describe('e.g. "Split-system air conditioner"'),
        cost_base: z.number().describe("Construction cost (Div 43) or asset cost (Div 40), AUD"),
        start_date: isoDate("Date construction completed / the asset was first used").optional(),
        effective_life_years: z.number().int().positive().optional().describe("Effective life in years (Div 40)"),
        rate: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe("Annual rate actually applied as a fraction, e.g. 0.025 — overrides the life-based rate"),
        opening_adjustable_value: z
          .number()
          .optional()
          .describe("Written-down value at start_date, AUD (omit for a new asset: defaults to cost_base)")
      }
    },
    async ({ fund_id, holding_id, ...depreciation_schedule }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/holdings/${holding_id}/depreciation_schedules`, {
          body: { depreciation_schedule }
        })
      )
  );

  server.registerTool(
    "update_depreciation_schedule",
    {
      title: "Correct a depreciation schedule",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Correct a depreciation schedule's basis (cost base, start date, effective life, rate, method, " +
        "description). Entries already calculated for open years are recalculated; closed or lodged years keep " +
        "their stored figures. Only the fields you pass change.",
      inputSchema: {
        fund_id: fundId,
        schedule_id: scheduleId,
        division: divisionEnum.optional(),
        method: methodEnum.optional(),
        description: z.string().optional(),
        cost_base: z.number().optional(),
        start_date: isoDate("Start date").optional(),
        effective_life_years: z.number().int().positive().optional(),
        rate: z.number().positive().max(1).optional(),
        opening_adjustable_value: z.number().optional()
      }
    },
    async ({ fund_id, schedule_id, ...depreciation_schedule }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/depreciation_schedules/${schedule_id}`, {
          body: { depreciation_schedule }
        })
      )
  );

  server.registerTool(
    "delete_depreciation_schedule",
    {
      title: "Remove a depreciation schedule",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Soft-delete a depreciation schedule and its entries in open years, so it stops feeding item 12 D1/E1. " +
        "Entries in closed or lodged years are kept (those returns were prepared from them).",
      inputSchema: { fund_id: fundId, schedule_id: scheduleId }
    },
    async ({ fund_id, schedule_id }) =>
      toResult(await api("DELETE", `/funds/${fund_id}/depreciation_schedules/${schedule_id}`))
  );

  server.registerTool(
    "calculate_depreciation",
    {
      title: "Calculate depreciation for a year",
      annotations: WRITES,
      description:
        "Generate (or refresh) each depreciation schedule's entry for a financial year, chaining the adjustable " +
        "value from earlier years — the figures that land on return item 12 D1 (capital works) and E1 (decline " +
        "in value) and clear gap G5. Returns the year's entries and D1/E1 totals in AUD (gross, before any " +
        "exempt-pension split). Refused for a closed or lodged year; earlier locked years are never rewritten.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        schedule_id: scheduleId.optional().describe("Only this schedule (default: all of the fund's schedules)")
      }
    },
    async ({ fund_id, financial_year, schedule_id }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/depreciation/calculate`, {
          body: schedule_id ? { schedule_id } : {}
        })
      )
  );
}
