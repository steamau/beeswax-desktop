#!/usr/bin/env node
/**
 * Beeswax Shares MCP server.
 *
 * A thin stdio MCP client over the Beeswax Shares JSON API (Rails, /api/v1).
 * Used by Claude Desktop / Claude Code for SMSF portfolio record-keeping.
 *
 * Env:
 *   BEESWAX_URL        — base URL of the app (default http://localhost:3000)
 *   BEESWAX_API_TOKEN  — API token, sent as `Authorization: Bearer <token>`
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_INSTRUCTIONS } from "./untrusted.js";
import { api, API_TOKEN, BASE_URL } from "./api.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { withWriteContext } from "./write_context.js";
import { register as register_portfolio } from "./tools/portfolio.js";
import { register as register_holdings } from "./tools/holdings.js";
import { register as register_transactions } from "./tools/transactions.js";
import { register as register_documents } from "./tools/documents.js";
import { register as register_costs_prices } from "./tools/costs_prices.js";
import { register as register_cash } from "./tools/cash.js";
import { register as register_smsf_return } from "./tools/smsf_return.js";
import { register as register_checks } from "./tools/checks.js";
import { register as register_financial_years } from "./tools/financial_years.js";
import { register as register_balance_items } from "./tools/balance_items.js";
import { register as register_ato_accounts } from "./tools/ato_accounts.js";
import { register as register_member_statements } from "./tools/member_statements.js";
import { register as register_valuations } from "./tools/valuations.js";
import { register as register_fund_admin } from "./tools/fund_admin.js";
import { register as register_year_end_pack } from "./tools/year_end_pack.js";
import { register as register_compliance_documents } from "./tools/compliance_documents.js";
import { register as register_navigation } from "./tools/navigation.js";

// ── Server + tools ─────────────────────────────────────────────────────────

const server = withWriteContext(new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION
  },
  { instructions: SERVER_INSTRUCTIONS }
));

// Registration order is the order list_tools returns. Each tools/<area>.ts owns one area.
register_portfolio(server, api);
register_holdings(server, api);
register_transactions(server, api);
register_documents(server, api);
register_costs_prices(server, api);
register_cash(server, api);
register_smsf_return(server, api);
register_checks(server, api);
register_financial_years(server, api);
register_balance_items(server, api);
register_ato_accounts(server, api);
register_member_statements(server, api);
register_valuations(server, api);
register_fund_admin(server, api);
register_year_end_pack(server, api);
register_compliance_documents(server, api);
register_navigation(server, api);

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  if (!API_TOKEN) {
    console.error(
      "[beeswax-shares-mcp] Warning: BEESWAX_API_TOKEN is not set — tool calls will fail until it is configured."
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[beeswax-shares-mcp] v${SERVER_VERSION} connected (API: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("[beeswax-shares-mcp] fatal:", err);
  process.exit(1);
});
