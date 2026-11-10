import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, WRITES, financialYearKeyEarly } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  // ── Compliance (step 3): the documents the law requires ─────────────────────
  // Each year asks for three: financial_statements, trustee_minutes and
  // investment_strategy. Retired types answer 410 with where their information
  // lives; auditor-requested (parked) types still work; a year kept on the
  // earlier list keeps every type.

  const RETIRED_NOTE =
    "Retired types (operating_statement, statement_of_financial_position, trustees_declaration, " +
    "detailed_operating_statement, investment_summary, tax_reconciliation, member_statements) are refused with " +
    "retired: true, a message saying where the information now lives and now_lives_in (pages with URLs) — not an " +
    "error to retry — except in a year kept on the earlier list.";

  server.registerTool(
    "mark_compliance_document_prepared",
    {
      title: "Mark a compliance document prepared",
      annotations: WRITES,
      description:
        "Mark one of the year's compliance documents (trustee_minutes, investment_strategy, or an " +
        "auditor-requested one such as trustee_residency_declaration — the part after \"compliance_document:\" in a " +
        "check key from get_return_checks) as prepared, by pointing at where it lives: document_id of a file " +
        "already sent with upload_document, and/or url (an https link such as a Claude Docs page), plus an " +
        "optional note. Its compliance_document:<type> check then reads Done. financial_statements is refused: it " +
        "freezes when the tax return is finalised. " + RETIRED_NOTE + " Refused for a locked year.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        document_type: z.string().describe('Compliance document type, e.g. "trustee_minutes"'),
        document_id: z.number().int().positive().optional().describe("A fund document from upload_document"),
        url: z.string().url().optional().describe("https link to the prepared document"),
        note: z.string().optional().describe("What it is / who prepared it")
      }
    },
    async ({ fund_id, financial_year, document_type, ...body }) =>
      toResult(
        await api(
          "POST",
          `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/compliance_documents/${encodeURIComponent(document_type)}/prepared`,
          { body }
        )
      )
  );

  server.registerTool(
    "generate_compliance_document",
    {
      title: "Generate a compliance document",
      annotations: WRITES,
      description:
        "Generate one of the year's generated compliance documents in Alpha — what the Prepare/Open button on " +
        "the Compliance step does: financial_statements (the statement of financial position and the operating " +
        "statement with the trustees' declaration as their signing block, figures from the return), " +
        "trustee_minutes, investment_strategy, or an auditor-requested one (notes_to_financial_statements, " +
        "trustee_representation_letter, related_party_confirmation, trustee_residency_declaration, " +
        "property_valuation). Answers fill the document's own fields (the result lists them, with any still " +
        "missing). Running it again updates the draft. The result's warnings list consistency failures (e.g. net " +
        "assets not equal to members' funds). finalize: true freezes it and its check reads Done — refused, with " +
        "blockers, while required fields are blank or, for a financial document, while the year has blocking " +
        "checks or it fails its consistency checks. financial_statements has no finalize: it freezes when the " +
        "return is finalised and unfreezes when it is unfinalised; the trustees' signatures are then recorded on " +
        "the web. not_applicable: true marks it N/A (not for the three required items). Uploaded types are refused " +
        "— use upload_document + mark_compliance_document_prepared. " + RETIRED_NOTE + " Refused for a locked " +
        "year or a document already finalised (reopen it on the web) — unless the result showed out_of_date: " +
        "true, in which case running it again regenerates it.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        document_type: z.string().describe('Compliance document type, e.g. "financial_statements"'),
        answers: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Field key → value; repeatable fields take an array of row objects"),
        title: z.string().optional(),
        notes: z.string().optional().describe("Internal notes on the document"),
        finalize: z.boolean().optional().describe("Freeze the document so it counts as done"),
        not_applicable: z.boolean().optional().describe("Mark it not applicable for this year instead")
      }
    },
    async ({ fund_id, financial_year, document_type, ...body }) =>
      toResult(
        await api(
          "POST",
          `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/compliance_documents/${encodeURIComponent(document_type)}/generate`,
          { body }
        )
      )
  );

  // ── Auditor requests (SIS Act s 35C(2)): documents asked for in writing ─────

  const requestsPath = (fund_id: number, financial_year: string) =>
    `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/auditor_requests`;

  server.registerTool(
    "list_auditor_requests",
    {
      title: "List the auditor's document requests",
      annotations: READS,
      description:
        "List what the fund's auditor has asked for in writing for a year, with the 14-day due date (SIS Act " +
        "s 35C(2)), days_left, overdue, and how each was answered. Anything beyond the required documents is " +
        "produced only when asked for.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly }
    },
    async ({ fund_id, financial_year }) => toResult(await api("GET", requestsPath(fund_id, financial_year)))
  );

  server.registerTool(
    "record_auditor_request",
    {
      title: "Record an auditor's document request",
      annotations: WRITES,
      description:
        "Record a document the auditor asked for in writing. due_on is set 14 days after requested_on " +
        "(default today). Record only what the auditor actually asked for.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        title: z.string().describe('What was asked for, e.g. "Trustee representation letter"'),
        body: z.string().optional().describe("The request's wording or detail"),
        requested_on: z.string().optional().describe("ISO date of the written request")
      }
    },
    async ({ fund_id, financial_year, ...body }) => toResult(await api("POST", requestsPath(fund_id, financial_year), { body }))
  );

  server.registerTool(
    "answer_auditor_request",
    {
      title: "Answer an auditor's document request",
      annotations: WRITES,
      description:
        "Answer an auditor request with a generated letter or an uploaded file: document_type generates (or " +
        "reuses) the year's draft of an auditor-requested type — trustee_representation_letter, " +
        "notes_to_financial_statements, related_party_confirmation, trustee_residency_declaration, " +
        "property_valuation — prefilled, with answers for its fields; or compliance_document_id for one already " +
        "prepared; or document_id for a file sent with upload_document. A generated letter is a draft: the " +
        "trustees finalise and sign it on the web.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        request_id: z.number().int().positive(),
        document_type: z.string().optional().describe("Auditor-requested type to generate as the answer"),
        compliance_document_id: z.number().int().positive().optional(),
        document_id: z.number().int().positive().optional().describe("A fund document from upload_document"),
        answers: z.record(z.string(), z.unknown()).optional().describe("Fields for a generated letter"),
        note: z.string().optional()
      }
    },
    async ({ fund_id, financial_year, request_id, ...body }) =>
      toResult(await api("POST", `${requestsPath(fund_id, financial_year)}/${request_id}/answer`, { body }))
  );
}
