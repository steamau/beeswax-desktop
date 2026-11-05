import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, WRITES_DESTRUCTIVE, financialYearKey } from "../shared.js";

const fundMemberId = z
  .number()
  .int()
  .positive()
  .describe("Fund member ID (the fund_member_id from list_member_statements)");

const aud = (what: string) => z.number().optional().describe(`${what}, AUD`);

// Every figure update_member_statement accepts, mirroring MemberStatement.
const statementFields = {
  account_status: z.enum(["open", "closed"]).optional().describe("Member account status (ATO label: account status)"),
  opening_balance: aud("Opening account balance at 1 July"),
  // Contributions (ATO labels A–M; their sum is N)
  employer_contributions: aud("Employer contributions (A)"),
  personal_contributions: aud("Personal contributions (B)"),
  cgt_small_business_retirement: aud("CGT small business retirement exemption (C)"),
  cgt_small_business_15yr: aud("CGT small business 15-year exemption (D)"),
  personal_injury: aud("Personal injury election (E)"),
  spouse_child_contributions: aud("Spouse and child contributions (F)"),
  other_third_party: aud("Other third-party contributions (G)"),
  downsizer_contributions: aud("Downsizer contributions"),
  downsizer_receipt_date: z.string().optional().describe('Date the downsizer contribution was received, ISO e.g. "2025-03-01"'),
  assessable_foreign_super: aud("Assessable foreign superannuation fund amount (I)"),
  non_assessable_foreign_super: aud("Non-assessable foreign superannuation fund amount (J)"),
  transfer_reserve_assessable: aud("Transfer from reserve: assessable amount (K)"),
  transfer_reserve_non_assessable: aud("Transfer from reserve: non-assessable amount (L)"),
  non_complying_contributions: aud("Contributions from non-complying funds and previously non-complying funds (T)"),
  other_contributions: aud("Any other contributions (M)"),
  // Movements
  allocated_earnings: aud("Allocated earnings or losses (O); negative for a loss. Prefer allocate_earnings"),
  inward_rollovers: aud("Inward rollovers and transfers (P)"),
  outward_rollovers: aud("Outward rollovers and transfers (Q)"),
  lump_sum_payment: aud("Lump sum payments (R1)"),
  income_stream_payment: aud("Income stream payments (R2)"),
  contributions_tax: aud("Contributions tax deducted from the member's account (reduces the computed closing balance)"),
  // Closing position
  accumulation_phase_balance: aud("Accumulation phase account balance (S1)"),
  retirement_phase_balance: aud("Retirement phase account balance (S2/S3)"),
  lrba_amount: aud("Outstanding LRBA amount attributable to the member"),
  tax_free_component: aud("Tax-free component of the closing balance"),
  taxable_component: aud("Taxable component of the closing balance"),
  preserved_amount: aud("Preserved benefits"),
  restricted_non_preserved_amount: aud("Restricted non-preserved benefits"),
  unrestricted_non_preserved_amount: aud("Unrestricted non-preserved benefits"),
  closing_balance: z
    .union([z.number(), z.literal("computed")])
    .optional()
    .describe(
      'Closing account balance (S). A number fixes the trustee\'s figure (basis "entered"); the string "computed" ' +
        "rolls it forward from the other figures on every save. Omit to leave the basis as it is."
    )
};

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "list_member_statements",
    {
      title: "List member statements",
      annotations: READS,
      description:
        "List each member's statement for a financial year — the figures behind the SMSF return's member sections " +
        "and item 16 W (total member closing balances). Includes every active member, with exists:false for members " +
        "that have no statement yet (missing_statements lists their fund_member_id; any missing statement raises " +
        "return gap G4). Each row carries the member name, opening balance, every contribution label, allocated " +
        "earnings, rollovers, benefit payments, contributions tax, phase balances, tax-free/taxable and preservation " +
        "components, and the closing balance with its basis: \"computed\" (rolled forward: opening + contributions + " +
        "earnings + rollovers in − rollovers out − payments − contributions tax) or \"entered\" (trustee's figure; " +
        "computed_closing_balance and closing_balance_difference show how far it is from the roll-forward). AUD.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("GET", `/funds/${fund_id}/financial_years/${financial_year}/member_statements`))
  );

  server.registerTool(
    "update_member_statement",
    {
      title: "Set a member statement's figures",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Create or update one member's statement for a financial year. Partial: only the fields you pass change. " +
        "If the member (identified by fund_member_id from list_member_statements) has no statement for the year yet, " +
        "one is created with a computed closing balance, so a fresh year can be populated field by field — e.g. set " +
        "each member's opening_balance, then the contributions, then run allocate_earnings. Amounts are AUD. " +
        "Rejected if the financial year is closed or lodged, or if creating a statement for an inactive member.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey, fund_member_id: fundMemberId, ...statementFields }
    },
    async ({ fund_id, financial_year, fund_member_id, ...fields }) =>
      toResult(
        await api("PATCH", `/funds/${fund_id}/financial_years/${financial_year}/member_statements/${fund_member_id}`, {
          body: { member_statement: fields }
        })
      )
  );

  server.registerTool(
    "allocate_earnings",
    {
      title: "Allocate the year's earnings to members",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Apportion the fund's net earnings for the year across the members' statements (allocated earnings, label O), " +
        "overwriting each statement's current figure; computed closing balances roll forward. method " +
        '"opening_balance" weights by opening balance; "average_daily_balance" (what trustee minutes usually ' +
        "specify) weights the opening balance for the full year plus each dated contribution, rollover or benefit " +
        "payment for the days remaining after it. Dated flows come from cash transactions attributed to the member; " +
        "a member whose statement shows flows with none dated falls back to the opening balance and the response " +
        "says so (per member: method_used, weight, share, note). Shares sum exactly to the total (the rounding cent " +
        "goes to the largest member). Omit total_earnings to use the net-assets roll-forward: net assets at 30 June " +
        "less each member's opening balance and non-earnings movements (contributions, rollovers, benefits, " +
        "contributions tax), so closing balances equal net assets; it includes unrealised movements and tax. The " +
        "response's earnings_figures gives that figure, the operating statement's (benefits accrued after tax − " +
        "contributions + contributions tax) and the difference between them. Use dry_run to preview. Members with no statement get no share — create their statements first. AUD.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        method: z
          .enum(["opening_balance", "average_daily_balance"])
          .optional()
          .describe('Weighting (default "opening_balance")'),
        total_earnings: z
          .number()
          .optional()
          .describe("Net earnings to allocate, AUD (negative for a loss). Omit to derive from the financial statements"),
        dry_run: z.boolean().optional().describe("Preview the split without writing")
      }
    },
    async ({ fund_id, financial_year, ...body }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/member_statements/allocate_earnings`, {
          body
        })
      )
  );
}
