import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// find_page / search_help / get_help: read-only tools that pass their arguments
// through to GET /pages and /help as query params.
async function withServer(fn) {
  const requests = [];
  const http = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: `http://127.0.0.1:${http.address().port}` },
    stderr: "ignore"
  });
  const client = new Client({ name: "navigation-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn({ client, requests });
  } finally {
    await client.close();
    http.close();
  }
}

test("navigation tools are read-only and the instructions point at them", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of ["find_page", "search_help", "get_help"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} registered`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} is read-only`);
    }
    assert.match(client.getInstructions() ?? "", /find_page/);
    assert.match(client.getInstructions() ?? "", /web_url/);
  });
});

test("find_page sends its context as query params", async () => {
  await withServer(async ({ client, requests }) => {
    await client.callTool({
      name: "find_page",
      arguments: { query: "member balances", fund_id: 3, financial_year: "2024-25", smsf_return_id: 9 }
    });
    const url = new URL(requests.at(-1).url, "http://x");
    assert.equal(url.pathname, "/api/v1/pages");
    assert.equal(url.searchParams.get("q"), "member balances");
    assert.equal(url.searchParams.get("fund_id"), "3");
    assert.equal(url.searchParams.get("financial_year"), "2024-25");
    assert.equal(url.searchParams.get("smsf_return_id"), "9");
    assert.equal(url.searchParams.has("holding_id"), false);
  });
});

test("help tools hit /help", async () => {
  await withServer(async ({ client, requests }) => {
    await client.callTool({ name: "search_help", arguments: { query: "franking" } });
    assert.equal(requests.at(-1).url, "/api/v1/help?q=franking");
    await client.callTool({ name: "get_help", arguments: { slug: "bank-feeds" } });
    assert.equal(requests.at(-1).url, "/api/v1/help/bank-feeds");
  });
});
