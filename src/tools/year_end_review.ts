import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, WRITES, financialYearKeyEarly } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  // ── Year-end review (step 1) ─────────────────────────────────────────────────

  server.registerTool(
    "get_year_end_review",
    {
      title: "Get the year-end review",
      annotations: READS,
      description:
        "The year-end review for a financial year (step 1, before the annual return): every check by section with " +
        "its status (ok / warn / bad / na), figure, reason, sign-off state (ready, to_review, stale, blocking), the " +
        "return fields it feeds, plus % ready, blockers, due dates and the year's discussion. Sign-offs and the " +
        "lock are made by people in the web app; you can explain checks and add notes.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("GET", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/review`), {
        untrusted: true
      })
  );

  server.registerTool(
    "get_year_end_review_check",
    {
      title: "Get one year-end check",
      annotations: READS,
      description:
        "One year-end check in full: its lines (the transactions or items behind it), decision options, sign-offs " +
        "and notes. check_key comes from get_year_end_review (e.g. \"bank_reconciled:12\", \"pension_minimum:4\").",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        check_key: z.string().describe("Check key from get_year_end_review")
      }
    },
    async ({ fund_id, financial_year, check_key }) =>
      toResult(
        await api(
          "GET",
          `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/review/checks/${encodeURIComponent(check_key)}`
        ),
        { untrusted: true }
      )
  );

  server.registerTool(
    "add_year_end_review_note",
    {
      title: "Add a note to a year-end check",
      annotations: WRITES,
      description:
        "Leave a note on a year-end check — what you found, what's needed to fix it, or why it may be acceptable. " +
        "A person still signs the check off. Pass check_key \"discussion\" to post in the year's discussion instead.",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        check_key: z.string().describe('Check key, or "discussion"'),
        body: z.string().min(1).describe("The note")
      }
    },
    async ({ fund_id, financial_year, check_key, body }) => {
      const base = `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/review`;
      const path = check_key === "discussion" ? `${base}/discussion` : `${base}/checks/${encodeURIComponent(check_key)}/notes`;
      return toResult(await api("POST", path, { body: { body, source: "mcp" } }));
    }
  );
}
