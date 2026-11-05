import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { toResult } from "../api.js";
import { financialYearKey, READS } from "../shared.js";

// Guiding the user around the web app: which page shows what (find_page), and the
// app's own help articles (search_help / get_help). Record-level links are the
// `web_url` fields on what the other tools return.
export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "find_page",
    {
      title: "Find a page in the web app",
      annotations: READS,
      description:
        "Find where something is in the Beeswax Shares (Alpha) web app: the page that shows a report or view, " +
        "where it sits in the menus, what it shows, and its URL. Use whenever the user asks where to see, find, " +
        "check, sign or do something in the app, or when you tell them to open a page — never construct or guess " +
        "an app URL yourself. Pass a few words in `query` (e.g. \"operating statement\", \"member balances\", " +
        "\"sign off\", \"bank feed\", \"API token\"); omit it to get the whole map. Pass fund_id (and optionally " +
        "financial_year, holding_id, bank_account_id) to get ready-to-click `url`s; otherwise pages come back " +
        "as `url_template`s listing the ids they `needs`. For one specific record (a holding, transaction, bank " +
        "account, return section or field, check) use the `web_url` on that record from the " +
        "tool that returned it instead.",
      inputSchema: {
        query: z.string().optional().describe("Words describing what the user wants to see or do; all must match"),
        fund_id: z.number().int().positive().optional().describe("Fund ID, to fill the fund into page URLs"),
        financial_year: financialYearKey.optional().describe(
          'Financial year label "2025-26" or id; defaults to the fund\'s current year'
        ),
        holding_id: z.number().int().positive().optional().describe("Holding ID, for holding pages"),
        bank_account_id: z.number().int().positive().optional().describe("Bank account ID, for account pages"),
        smsf_return_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Annual return ID; defaults to the financial year's current return, if one has been started")
      }
    },
    async ({ query, fund_id, financial_year, holding_id, bank_account_id, smsf_return_id }) =>
      toResult(
        await api("GET", "/pages", {
          query: { q: query, fund_id, financial_year, holding_id, bank_account_id, smsf_return_id }
        })
      )
  );

  server.registerTool(
    "search_help",
    {
      title: "Search help articles",
      annotations: READS,
      description:
        "Search the Beeswax Shares in-app help articles (getting started, holdings, transactions, bank feeds, " +
        "scenarios, tax, true ROI, glossary…). Returns slug, title, summary and the page keys (from find_page) " +
        "each article explains. Omit query to list every article. Read one with get_help.",
      inputSchema: {
        query: z.string().optional().describe("Words to search for; all must appear in the article")
      }
    },
    async ({ query }) => toResult(await api("GET", "/help", { query: { q: query } }))
  );

  server.registerTool(
    "get_help",
    {
      title: "Get a help article",
      annotations: READS,
      description:
        "Read one Beeswax Shares help article in full (Markdown), by slug from search_help. Use it to explain " +
        "how a part of the app works in the app's own terms before pointing the user at the page.",
      inputSchema: {
        slug: z.string().min(1).describe('Article slug, e.g. "holdings" or "bank-feeds"')
      }
    },
    async ({ slug }) => toResult(await api("GET", `/help/${encodeURIComponent(slug)}`))
  );
}
