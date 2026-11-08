import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { fundId, READS, financialYearKeyEarly } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  // ── The tax return's checks ──────────────────────────────────────────────────
  // There is no separate year-end review: the checks run against the tax return.
  // Each lives on the Books step (books_* groups), in a return section (where its
  // figures land), or on the Compliance step (SIS compliance tests, documents).

  server.registerTool(
    "get_return_checks",
    {
      title: "Get the year's checks",
      annotations: READS,
      description:
        "Every check for a financial year: where it lives (placement — a Books group: \"books_bank\", " +
        "\"books_income\", \"books_holdings\", \"books_other\"; a tax return section such as \"income\" or " +
        "\"assets_liabilities\"; or a Compliance group: \"compliance_tests\", \"documents\"), its " +
        "status (ok / warn / bad / na), state (ready, attention, blocking, accepted, na), figure, reason, the return " +
        "fields it feeds, and any answer a person recorded. Blocking checks on the Books step and on the return stop the " +
        "return being finalised. Answering or accepting a check is a person's call in the web app; explain what you " +
        "found with add_smsf_return_field_note on the figures it affects.",
      inputSchema: { fund_id: fundId, financial_year: financialYearKeyEarly }
    },
    async ({ fund_id, financial_year }) =>
      toResult(await api("GET", `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/checks`), {
        untrusted: true
      })
  );

  server.registerTool(
    "get_return_check",
    {
      title: "Get one check",
      annotations: READS,
      description:
        "One check in full: its lines (the transactions or items behind it), help, decision options and any recorded " +
        "answer. check_key comes from get_return_checks (e.g. \"bank_reconciled:12\", \"pension_minimum:4\").",
      inputSchema: {
        fund_id: fundId,
        financial_year: financialYearKeyEarly,
        check_key: z.string().describe("Check key from get_return_checks")
      }
    },
    async ({ fund_id, financial_year, check_key }) =>
      toResult(
        await api(
          "GET",
          `/funds/${fund_id}/financial_years/${encodeURIComponent(financial_year)}/checks/${encodeURIComponent(check_key)}`
        ),
        { untrusted: true }
      )
  );
}
