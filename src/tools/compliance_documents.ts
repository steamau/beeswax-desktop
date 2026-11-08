import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, WRITES, financialYearKeyEarly } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  // ── Compliance (step 2): the year's documents ───────────────────────────────

  server.registerTool(
    "mark_compliance_document_prepared",
    {
      title: "Mark a compliance document prepared",
      annotations: WRITES,
      description:
        "Mark one of the year's compliance documents (e.g. trustee_residency_declaration, investment_strategy_review, " +
        "trustee_minutes — the part after \"compliance_document:\" in a check key from get_return_checks) as " +
        "prepared, by pointing at where it lives: document_id of a file already sent with upload_document, and/or " +
        "url (an https link such as a Claude Docs page), plus an optional note. The check compliance_document:<type> " +
        "on the Compliance step then reads Done. Refused for a locked year.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        document_type: z.string().describe('Compliance document type, e.g. "trustee_residency_declaration"'),
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
        "Generate one of the year's generated compliance documents in Alpha — what the Generate button on the " +
        "Compliance step does (e.g. operating_statement, statement_of_financial_position, trustee_minutes, " +
        "trustees_declaration; the part after \"compliance_document:\" in a check key). Figures come from the " +
        "ledger; answers fill the document's own fields (the result lists them, with any still missing). Running it " +
        "again updates the draft. finalize: true freezes it and its check reads Done (refused while required " +
        "fields are blank); not_applicable: true marks it N/A instead. Uploaded types (bank statements, signed " +
        "files) are refused — use upload_document + mark_compliance_document_prepared. Refused for a locked year " +
        "or a document already finalised (reopen it on the web).",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        document_type: z.string().describe('Compliance document type, e.g. "operating_statement"'),
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
}
