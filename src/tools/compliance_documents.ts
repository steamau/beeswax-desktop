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
}
