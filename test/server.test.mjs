import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Boots the built server over stdio and checks the injection-hardening surface:
// server instructions delivered at initialize, and read-only/destructive
// annotations on the tools. No API calls are made (the URL points nowhere).
test("server exposes untrusted-data instructions and tool annotations", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "hardening-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /untrusted DATA/);
    assert.match(instructions, /suspected_injection/);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    assert.equal(byName.get("get_portfolio").annotations.readOnlyHint, true);
    assert.equal(byName.get("get_document").annotations.readOnlyHint, true);
    assert.equal(byName.get("record_trade").annotations.readOnlyHint, false);
    assert.equal(byName.get("record_trade").annotations.destructiveHint, false);
    assert.equal(byName.get("detach_cash_transaction").annotations.destructiveHint, true);
    assert.equal(byName.get("update_price").annotations.destructiveHint, true);
    assert.equal(byName.get("update_holding").annotations.readOnlyHint, false);
    assert.equal(byName.get("update_holding").annotations.destructiveHint, true);

    // Every tool must carry an explicit annotation.
    for (const tool of tools) {
      assert.ok(tool.annotations, `missing annotations on ${tool.name}`);
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
    }
  } finally {
    await client.close();
  }
});
