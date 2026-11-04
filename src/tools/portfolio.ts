import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { BASE_URL, toResult } from "../api.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { fundId, isoDate, pageParam, perPageParam, READS } from "../shared.js";

export function register(server: McpServer, api: Api): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      annotations: READS,
      description:
        "Identify the authenticated Beeswax Shares user, the API token's scopes, and the SMSF funds the token " +
        "can access (with their fund IDs). Call this FIRST in a session to discover fund IDs — almost every " +
        "other tool needs a fund_id.",
      inputSchema: {}
    },
    async () => {
      const me = await api("GET", "/me");
      const body = me.body && typeof me.body === "object" && !Array.isArray(me.body) ? me.body : { me: me.body };
      return toResult({ ...me, body: { ...body, mcp_server: serverInfo() } });
    }
  );

  server.registerTool(
    "server_info",
    {
      title: "MCP server info",
      annotations: READS,
      description:
        "Report this MCP server's name, version, tool count and the API base URL it talks to. Makes no API " +
        "call, so it works even when the token is missing or wrong. Use it to confirm which release of the " +
        "Beeswax Shares connector a session is running (whoami also returns this under mcp_server).",
      inputSchema: {}
    },
    async () => toResult({ body: serverInfo() })
  );

  function serverInfo() {
    // Registered tools on the underlying SDK server (private field; count only).
    const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
    return {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      tool_count: registered ? Object.keys(registered).length : undefined,
      api_base_url: BASE_URL
    };
  }

  server.registerTool(
    "list_funds",
    {
      title: "List funds",
      annotations: READS,
      description:
        "List your SMSF funds with headline figures: total value, cost base, unrealised gain/loss, total " +
        "income, true return percentages, active holdings count and current financial year. Use when you need " +
        "fund-level numbers; use whoami if you only need fund IDs.",
      inputSchema: { page: pageParam, per_page: perPageParam }
    },
    async ({ page, per_page }) => toResult(await api("GET", "/funds", { query: { page, per_page } }))
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Get portfolio snapshot",
      annotations: READS,
      description:
        "Full portfolio snapshot for one SMSF fund: fund summary (value, cost base, unrealised gain/loss, " +
        "income, true return), asset allocation percentages, and every active holding with current value and " +
        "returns. The best single call to answer 'how is the fund doing?' or 'what do we hold?'. All amounts AUD.",
      inputSchema: { fund_id: fundId }
    },
    async ({ fund_id }) => toResult(await api("GET", `/funds/${fund_id}/portfolio`))
  );

  server.registerTool(
    "list_holdings",
    {
      title: "List holdings",
      annotations: READS,
      description:
        "List holdings in a fund, with filters. Use to find a holding's ID by ticker or name (e.g. before " +
        "record_cost or update_price), or to review holdings by status. Returns valuation and gain/loss per holding.",
      inputSchema: {
        fund_id: fundId,
        status: z.string().optional().describe('Filter by holding status, e.g. "active" or "sold"'),
        ticker: z.string().optional().describe('Exact ticker symbol match (case-insensitive), e.g. "VAS"'),
        search: z.string().optional().describe("Substring search over holding name and ticker"),
        page: pageParam,
        per_page: perPageParam
      }
    },
    async ({ fund_id, status, ticker, search, page, per_page }) =>
      toResult(
        await api("GET", `/funds/${fund_id}/holdings`, {
          query: { status, ticker, search, page, per_page }
        })
      )
  );

  server.registerTool(
    "get_holding_analysis",
    {
      title: "Get holding analysis",
      annotations: READS,
      description:
        "Deep analysis of a single holding: true return (income + growth − costs), annualised return, income " +
        "totals (dividends, distributions, interest, rent, franking credits), costs to date, CGT discount " +
        "eligibility, estimated CGT and net proceeds if sold today. Use when asked how a specific " +
        "investment has really performed, or about the tax impact of selling. All amounts AUD.",
      inputSchema: {
        fund_id: fundId,
        holding_id: z.number().int().positive().describe("Holding ID (find via list_holdings)")
      }
    },
    async ({ fund_id, holding_id }) =>
      toResult(await api("GET", `/funds/${fund_id}/holdings/${holding_id}/analysis`))
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      annotations: READS,
      description:
        "Search the fund's transaction ledger across all holdings — this is the 'memory recall' tool for " +
        "your SMSF record-keeping. Use to answer 'did we already record this dividend?', 'what did we buy " +
        "in FY 2025-26?', or to check for duplicates before proposing a new record. Filter by type, financial " +
        "year, date range and ticker. Results are newest-first and paginated.",
      inputSchema: {
        fund_id: fundId,
        transaction_type: z
          .string()
          .optional()
          .describe('Filter by type, e.g. "buy", "sell", "dividend", "distribution", "interest", "rental_income"'),
        financial_year: z
          .string()
          .optional()
          .describe('Australian financial year label, e.g. "2025-26" (July–June)'),
        from: isoDate("Earliest transaction date (inclusive)").optional(),
        to: isoDate("Latest transaction date (inclusive)").optional(),
        ticker: z.string().optional().describe('Exact ticker symbol (case-insensitive), e.g. "BHP"'),
        page: pageParam,
        per_page: perPageParam
      }
    },
    async ({ fund_id, transaction_type, financial_year, from, to, ticker, page, per_page }) =>
      toResult(
        await api("GET", `/funds/${fund_id}/transactions`, {
          query: { transaction_type, financial_year, from, to, ticker, page, per_page }
        }),
        { untrusted: true }
      )
  );
}
