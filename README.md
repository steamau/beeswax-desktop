# Beeswax Shares MCP Server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server for **Beeswax Shares**, the SMSF (Australian self-managed super fund) portfolio app. It is a thin client over the app's JSON API (`/api/v1`), letting Claude (Desktop or Code) read portfolio data, recall transaction history, upload statements, and **propose** new ledger records for human review.

Claude connects to it over stdio. All money amounts are AUD unless stated otherwise.

## How writes work (important)

The `record_trade` and `record_income` tools **never write directly to the ledger**. They create *proposed transactions* that land in the app's **Review Queue**, where a human approves or rejects them before anything touches the books. Proposals accept an `external_ref` idempotency key, so repeated imports of the same source (e.g. the same email) will not create duplicates.

`record_cost` and `update_price` write low-risk records (holding costs and price observations) directly. `create_holding` creates a new security record directly — the buy itself should still go through `record_trade`.

## Tools

| Tool | What it does |
|------|--------------|
| `whoami` | Identify user, token scopes, and accessible fund IDs — call first |
| `list_funds` | Funds with value, cost base, returns, holdings count |
| `get_portfolio` | Full snapshot: summary, asset allocation, holdings with values/returns |
| `list_holdings` | Holdings with filters (`status`, `ticker`, `search`), paginated |
| `get_holding_analysis` | True return, income/cost totals, CGT estimate, net proceeds if sold |
| `search_transactions` | Ledger search (type, financial year, date range, ticker) — "memory recall" |
| `create_holding` | Create a brand-new security/asset in the fund |
| `record_trade` | Propose a buy/sell (pending human review) |
| `record_income` | Propose a dividend/distribution/interest/rental income (pending human review) |
| `list_pending_proposals` | Proposals awaiting review in the app's Review Queue |
| `upload_document` | Upload a local PDF/CSV statement; extraction + reconciliation run automatically |
| `get_document` | Document + extracted statement lines with match statuses |
| `list_documents` | Uploaded documents with extraction status |
| `reconcile_document` | Re-run statement-vs-ledger matching; returns a summary |
| `record_cost` | Record a holding cost/expense (insurance, rates, fees…) |
| `update_price` | Record a price observation; refreshes the holding's current price |
| `list_brokers` | Known brokers (for `broker_id` lookups) |
| `list_asset_types` | Supported asset types (for `create_holding`) |

List tools include a `pagination` object (`total_count`, `page`, `per_page`, `total_pages`) in their results. `page`/`per_page` query params are supported, `per_page` max 100.

## Creating an API token

1. Sign in to the Beeswax Shares app.
2. Go to **Account → API Access**.
3. Create a token with the scopes you need (read scopes for browsing; `proposals:write`, `documents:write`, `costs:write`, `prices:write`, `holdings:write` for the write tools).
4. Copy the token — it is shown once.

## Build

Requires Node 18+.

```sh
cd mcp-server
npm install
npm run build
```

This compiles TypeScript to `dist/index.js`.

## Distribute as a Desktop Extension (`.mcpb`)

The easiest way to give this to other people is to package it as a **Desktop Extension** — a single `.mcpb` file they open in Claude Desktop. Claude Desktop runs it with its **own bundled Node** (users need nothing installed) and prompts each user for their **own** API token, stored securely in the OS keychain. Each token scopes access to that user's own funds, so the same bundle works for everyone.

### Build the bundle (maintainer)

```sh
cd mcp-server
npm install            # all deps (incl. TypeScript, for the build)
npm run build          # compile to dist/index.js
npm prune --omit=dev   # drop dev deps so they don't ship in the bundle
npx @anthropic-ai/mcpb pack . beeswax-shares.mcpb
```

This produces `beeswax-shares.mcpb` (~3 MB). The bundle's metadata and the user-facing config form live in [`manifest.json`](manifest.json); `mcpb pack` validates it. Distribute the `.mcpb` via a GitHub Release, a download link, or email — it is a build artifact and is git-ignored, not committed.

> Optional: `npx @anthropic-ai/mcpb sign` adds a code signature so users don't see an "unverified publisher" prompt on install. Unsigned bundles still install fine, with a one-time confirmation.

### Install (end user)

1. Download `beeswax-shares.mcpb`.
2. Open it with **Claude Desktop** (double-click) — an install dialog appears.
3. When prompted, paste your **API token** (create one at **Account → API Access** in Beeswax Shares — it is shown only once). Leave **Server URL** as the default unless you run your own instance.
4. Done — the Beeswax Shares tools are now available in Claude.

## Configuration (manual / developer setup)

For local development or non-Desktop clients, configure the two environment variables directly. End users should prefer the `.mcpb` Desktop Extension above.

Two environment variables:

| Variable | Meaning | Default |
|----------|---------|---------|
| `BEESWAX_URL` | Base URL of the Beeswax Shares app | `http://localhost:3000` |
| `BEESWAX_API_TOKEN` | API token, sent as `Authorization: Bearer <token>` | *(required)* |

> If your default `node` is older than 18 (check `node --version`), use the absolute path to a Node 18+ binary in the configs below, e.g. `~/.nvm/versions/node/v20.18.0/bin/node`.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "beeswax-shares": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "BEESWAX_URL": "https://alpha.beeswaxapp.com",
        "BEESWAX_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add beeswax-shares \
  -e BEESWAX_URL=https://alpha.beeswaxapp.com \
  -e BEESWAX_API_TOKEN=your-token-here \
  -- node /path/to/mcp-server/dist/index.js
```

## Security note

The API token grants access to the fund's financial records — treat it like a password: keep it out of source control, scope it minimally, and revoke it from **Account → API Access** if it leaks. As a safeguard, the `record_trade` / `record_income` tools only ever create **proposals pending human approval** in the app's Review Queue; they cannot post to the ledger directly. All API writes are audit-logged server-side.
