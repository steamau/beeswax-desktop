import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, WRITES, financialYearKeyEarly } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  // ── The audit program ────────────────────────────────────────────────────────
  // The Audit step, for the auditor's assistant: the standard SMSF audit laid out
  // stage by stage (engagement, the fund, planning, Part A financial, Part B
  // compliance, conclude), each line with its figure, what proves it and the
  // auditor's sign-off. The same program the web shows, so the two never differ.
  // An auditor's token is read-only everywhere except these tools' writes.

  const base = (fund_id: number, financial_year: string) =>
    `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}`;
  const lineKey = z
    .string()
    .describe('A program line\'s key from get_audit_program, e.g. "bank.4", "holding.12", "partb.s62", "tie.net_assets"');

  server.registerTool(
    "get_audit_program",
    {
      title: "Get the year's audit program",
      annotations: READS,
      description:
        "The audit program for a fund's financial year — START HERE when auditing. Stages in the order an SMSF audit " +
        "runs: engage (auditor, how the ledger was built), fund (permanent records, the year's signed documents, " +
        "last year's audit), plan (figures frozen, a materiality guide, year-on-year movements, large transactions, " +
        "checks a person accepted), part_a (statements tie out, each bank account, each investment, other balances, " +
        "the operating statement and its tests), part_b (each SIS section and regulation the audit report covers) " +
        "and conclude. Each line has a key, state (ready = supported, attention, blocking, na, info = a fact to " +
        "read, manual = no test in Alpha: the auditor's own procedure, described in procedure), figure, proven_by, " +
        "evidence_gap (a source document an auditor expects that isn't on file) and its signoff. Also returns " +
        "ledger_sources (how many of the year's rows came from the bank feed, a statement, the trustee's AI " +
        "assistant, or were typed), the open queries, and role (your role on the fund). Open a line with " +
        "get_audit_line.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly }
    },
    async ({ fund_id, financial_year }) => toResult(await api("GET", `${base(fund_id, financial_year)}/audit_program`))
  );

  server.registerTool(
    "get_audit_line",
    {
      title: "Open one line of the audit program",
      annotations: READS,
      description:
        "Everything behind one line of the audit program: the facts (for a bank account: opening, ledger and the " +
        "bank's own balance, what proves it, lines ticked, statement gaps; for an investment: units, cost, market " +
        "value, the price used and where it came from), the working as tables (the bank's balances against the " +
        "ledger, rows not read from the bank, movements in the year, the operating statement's rows), the checks " +
        "that test it with any note a person accepted them with, the source documents on file (documents — read " +
        "one with download_document; covers_year_end marks the statement covering 30 June) and the queries raised " +
        "on it. Compare the document with the figure yourself: Alpha's figure is the claim, the document is the " +
        "evidence.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly, line_key: lineKey }
    },
    async ({ fund_id, financial_year, line_key }) =>
      toResult(await api("GET", `${base(fund_id, financial_year)}/audit_program/lines/${encodeURIComponent(line_key)}`))
  );

  server.registerTool(
    "select_audit_sample",
    {
      title: "Select a sample of transactions to vouch",
      annotations: READS,
      description:
        "A reproducible sample of the year's ledger rows to vouch to documents. By default the population is only " +
        "rows a person or the trustee's AI assistant entered — rows read from the bank's feed or a statement " +
        "already carry the bank's record (include_bank_sourced: true samples everything). basis \"value\" takes " +
        "the largest half by amount and draws the rest at random; \"random\" draws them all. The same seed over " +
        "the same ledger returns the same rows, so record the seed with your working paper. Each row says where " +
        "it came from, who entered it, and the documents or invoice attached.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        size: z.number().int().min(1).max(60).optional().describe("Rows to select (default 15)"),
        seed: z.string().optional().describe("Any text; the same seed reproduces the sample"),
        basis: z.enum(["value", "random"]).optional(),
        include_bank_sourced: z.boolean().optional()
      }
    },
    async ({ fund_id, financial_year, ...query }) =>
      toResult(await api("GET", `${base(fund_id, financial_year)}/audit_program/sample`, { query }))
  );

  server.registerTool(
    "list_changes_since_finalised",
    {
      title: "List ledger changes since the return was finalised",
      annotations: READS,
      description:
        "Ledger changes recorded after the tax return was finalised (who, when, what) — the figures the auditor " +
        "was given should not have moved. Empty while the return stays finalised, since finalising locks the " +
        "year; a note says so when the return isn't finalised yet and its figures can still change.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly }
    },
    async ({ fund_id, financial_year }) => toResult(await api("GET", `${base(fund_id, financial_year)}/audit_program/changes`))
  );

  server.registerTool(
    "sign_off_audit_line",
    {
      title: "Sign off a line of the audit program",
      annotations: WRITES,
      description:
        "Record the AUDITOR's sign-off on one line: status \"reviewed\" (the evidence supports it) or \"exception\" " +
        "(it doesn't — a note is required). Only a token belonging to the fund's auditor can. The sign-off is the " +
        "auditor's conclusion, not yours: show them the line, its figure, what you tested against which document, " +
        "and the note, and call this only after an explicit yes, with confirmed_by_user: true. Put what was tested " +
        "in note (it becomes the working paper for the line). Recorded as signed via their assistant.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        line_key: lineKey,
        status: z.enum(["reviewed", "exception"]),
        note: z.string().optional().describe("What was tested and found; required for an exception"),
        confirmed_by_user: z.boolean().describe("true only after the auditor has said yes to this line")
      }
    },
    async ({ fund_id, financial_year, line_key, ...body }) =>
      toResult(
        await api("POST", `${base(fund_id, financial_year)}/audit_program/lines/${encodeURIComponent(line_key)}/signoff`, { body })
      )
  );

  // ── Audit queries: one thread both sides' assistants work ──────────────────

  server.registerTool(
    "list_audit_queries",
    {
      title: "List the year's audit queries",
      annotations: READS,
      description:
        "The auditor's queries on a year, each a thread: status open (waiting on the trustee), resolved (answered, " +
        "waiting on the auditor) or closed (the auditor accepted the answer), the answer, any replies, and the " +
        "program line or return figure it is about (context). For the trustee's assistant: open ones are yours to " +
        "answer with answer_audit_query.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        status: z.enum(["open", "resolved", "closed"]).optional()
      }
    },
    async ({ fund_id, financial_year, ...query }) =>
      toResult(await api("GET", `${base(fund_id, financial_year)}/audit_queries`, { query }))
  );

  server.registerTool(
    "raise_audit_query",
    {
      title: "Raise an audit query",
      annotations: WRITES,
      description:
        "AUDITOR only: raise a query for the trustee to answer. Pass line_key to put it on a line of the audit " +
        "program (it shows on that line), or leave it out for a query about the year as a whole. Say what doesn't " +
        "agree and what would settle it. For a document you need, use request_audit_document instead: that starts " +
        "the 14-day clock.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        title: z.string().describe("The question in one line"),
        body: z.string().optional().describe("What you found and what would settle it"),
        line_key: lineKey.optional()
      }
    },
    async ({ fund_id, financial_year, ...body }) =>
      toResult(await api("POST", `${base(fund_id, financial_year)}/audit_queries`, { body }))
  );

  server.registerTool(
    "answer_audit_query",
    {
      title: "Answer an audit query",
      annotations: WRITES,
      description:
        "TRUSTEE or accountant only: answer an open audit query. Say what the figure is, where it comes from, and " +
        "name the document that shows it (upload it with upload_document first if it isn't on file). The auditor " +
        "then closes the query or follows up.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        query_id: z.number().int().positive(),
        body: z.string()
      }
    },
    async ({ fund_id, financial_year, query_id, ...body }) =>
      toResult(await api("POST", `${base(fund_id, financial_year)}/audit_queries/${query_id}/answer`, { body }))
  );

  server.registerTool(
    "reply_audit_query",
    {
      title: "Reply on an audit query",
      annotations: WRITES,
      description:
        "Add a message to an audit query's thread, from either side. A reply from the auditor on an answered query " +
        "puts it back with the trustee.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        query_id: z.number().int().positive(),
        body: z.string()
      }
    },
    async ({ fund_id, financial_year, query_id, ...body }) =>
      toResult(await api("POST", `${base(fund_id, financial_year)}/audit_queries/${query_id}/reply`, { body }))
  );

  server.registerTool(
    "close_audit_query",
    {
      title: "Close an audit query",
      annotations: WRITES,
      description:
        "AUDITOR only: close a query once its answer satisfies the auditor. Their call: tell them what the answer " +
        "says and what you checked it against, and close it when they agree.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly, query_id: z.number().int().positive() }
    },
    async ({ fund_id, financial_year, query_id }) =>
      toResult(await api("POST", `${base(fund_id, financial_year)}/audit_queries/${query_id}/close`))
  );

  server.registerTool(
    "request_audit_document",
    {
      title: "Ask the trustees for a document",
      annotations: WRITES,
      description:
        "AUDITOR only: ask the trustees in writing for a document (a title search, the representation letter, a " +
        "statement covering 30 June). They must give it within 14 days (SIS Act s 35C(2)); the due date is set " +
        "from today. See what is outstanding with list_auditor_requests.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        title: z.string().describe("What you need"),
        body: z.string().optional().describe("Detail: which asset, which period")
      }
    },
    async ({ fund_id, financial_year, ...body }) =>
      toResult(await api("POST", `${base(fund_id, financial_year)}/auditor_requests`, { body }))
  );
}
