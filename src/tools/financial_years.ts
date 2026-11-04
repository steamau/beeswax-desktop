import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, isoDate, READS, WRITES, WRITES_DESTRUCTIVE, financialYearKey, bankAccountId } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "list_financial_years",
    {
      title: "List financial years",
      annotations: READS,
      description:
        "List a fund's financial years with their status (open / closed / lodged) and close/lodge dates. " +
        "Use to find the year label to reconcile, close or lodge.",
      inputSchema: { fund_id: fundId }
    },
    async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/financial_years`))
  );

  server.registerTool(
    "reconcile_cash_transaction",
    {
      title: "Reconcile cash transaction",
      annotations: WRITES,
      description:
        "Tick a single cash row off against the bank statement (the line-level 'reconciled' flag, recording " +
        "that it has been checked against the official statement). Writes immediately. Rejected if the row's " +
        "financial year is already closed/lodged — reconcile before closing the year.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: bankAccountId,
        cash_transaction_id: z.number().int().positive().describe("The cash transaction to reconcile")
      }
    },
    async ({ fund_id, bank_account_id, cash_transaction_id }) =>
      toResult(
        await api(
          "POST",
          `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/reconcile`
        )
      )
  );

  server.registerTool(
    "unreconcile_cash_transaction",
    {
      title: "Unreconcile cash transaction",
      annotations: WRITES,
      description:
        "Remove the statement-reconciliation tick from a cash row, returning it to 'not yet checked against " +
        "the statement'. The inverse of reconcile_cash_transaction.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: bankAccountId,
        cash_transaction_id: z.number().int().positive().describe("The cash transaction to unreconcile")
      }
    },
    async ({ fund_id, bank_account_id, cash_transaction_id }) =>
      toResult(
        await api(
          "DELETE",
          `/funds/${fund_id}/bank_accounts/${bank_account_id}/cash_transactions/${cash_transaction_id}/unreconcile`
        )
      )
  );

  server.registerTool(
    "record_statement_balance",
    {
      title: "Record statement balance",
      annotations: WRITES_DESTRUCTIVE,
      description:
        "Record (or correct) a bank statement's closing balance as at a date — the snapshot the year-end " +
        "balance reconciliation proves the ledger against. One snapshot per date (re-recording the same date " +
        "updates it). Use the statement's closing balance and its closing date. Amounts in AUD.",
      inputSchema: {
        fund_id: fundId,
        bank_account_id: bankAccountId,
        as_at: isoDate("Statement closing date"),
        current_balance: z.number().describe("Statement closing balance in AUD")
      }
    },
    async ({ fund_id, bank_account_id, ...statement_balance }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/bank_accounts/${bank_account_id}/record_statement_balance`, {
          body: { statement_balance }
        })
      )
  );

  server.registerTool(
    "run_account_reconciliation",
    {
      title: "Run account reconciliation (cash matcher)",
      annotations: WRITES,
      description:
        "Run the cash matcher over a bank account's unmatched feed rows — link settlement legs to trades/income, " +
        "pair internal transfers, and categorise cash-only events (interest, fees). Returns the match summary. " +
        "Use after recording trades/income to auto-link the matching bank rows.",
      inputSchema: { fund_id: fundId, bank_account_id: bankAccountId }
    },
    async ({ fund_id, bank_account_id }) =>
      toResult(await api("POST", `/funds/${fund_id}/bank_accounts/${bank_account_id}/reconcile`))
  );

  server.registerTool(
    "reconcile_financial_year",
    {
      title: "Reconcile financial year",
      annotations: WRITES,
      description:
        "Run reconciliation for a whole financial year: match cash, then compute a balance proof per bank " +
        "account (opening + movements vs the statement closing balance). Returns the balance proofs and the run " +
        "summary. Record statement balances first so accounts can reconcile rather than fall out of scope.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/reconcile`))
  );

  server.registerTool(
    "close_financial_year",
    {
      title: "Close financial year",
      annotations: WRITES,
      description:
        "Close a financial year — locks its year-end review and every dated row in that year against further " +
        "edits. Only works once every check in the year-end review has been signed off by a person in the web " +
        "app; otherwise returns an error with the outstanding checks (see get_year_end_review).",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/close`))
  );

  server.registerTool(
    "lodge_financial_year",
    {
      title: "Lodge financial year",
      annotations: WRITES,
      description:
        "Mark a closed financial year as lodged with the ATO when its return was prepared and lodged outside " +
        "Alpha. A year with an annual return in Alpha is lodged by marking that return lodged in the web app " +
        "(after the audit and the trustees' declarations) — this tool refuses it.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/lodge`))
  );

  server.registerTool(
    "reopen_financial_year",
    {
      title: "Reopen financial year",
      annotations: WRITES,
      description:
        "Reopen a closed financial year (back to open), unlocking its year-end review and its rows for edits. " +
        "Refused while the year's return is finalised — reopen the return first. To revert a lodged year use " +
        "unlodge_financial_year first.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKey }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/reopen`))
  );

  server.registerTool(
    "unlodge_financial_year",
    {
      title: "Unlodge financial year",
      annotations: WRITES,
      description:
        "Revert a lodged financial year back to closed. Keeps an audit note. Only for a year lodged outside " +
        "Alpha — when the year's return holds the lodgement record, amend or unlodge the return in the web app.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        note: z.string().optional().describe("Reason for unlodging (kept on the year's audit note)")
      }
    },
    async ({ fund_id, financial_year, note }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/unlodge`, { body: { note } })
      )
  );

  server.registerTool(
    "attest_account",
    {
      title: "Attest account out of scope",
      annotations: WRITES,
      description:
        "Manually sign off a bank account for a financial year as out of scope (no feed/statement proof) so " +
        "the year can still close. Use for accounts with no statement to reconcile against.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKey,
        bank_account_id: bankAccountId,
        notes: z.string().optional().describe("Why this account is out of scope")
      }
    },
    async ({ fund_id, financial_year, ...body }) =>
      toResult(
        await api("POST", `/funds/${fund_id}/financial_years/${financial_year}/attest`, { body })
      )
  );
}
