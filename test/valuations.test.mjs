import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Boots the built server over stdio and checks the EOFY valuation tools are
// registered with the right annotations and inputs. No API calls are made.
test("valuation tools are registered with annotations", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "valuations-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const list = byName.get("list_valuations");
    assert.ok(list, "list_valuations missing");
    assert.equal(list.annotations.readOnlyHint, true);
    assert.deepEqual([...list.inputSchema.required].sort(), ["financial_year", "fund_id"]);

    const record = byName.get("record_valuation");
    assert.ok(record, "record_valuation missing");
    assert.equal(record.annotations.readOnlyHint, false);
    assert.equal(record.annotations.destructiveHint, true);
    for (const key of ["fund_id", "financial_year", "holding_id", "evidence"]) {
      assert.ok(record.inputSchema.required.includes(key), `record_valuation should require ${key}`);
    }
    for (const key of ["market_value", "price_per_unit", "source", "price_date"]) {
      assert.ok(key in record.inputSchema.properties, `record_valuation should accept ${key}`);
    }
    assert.match(byName.get("update_price").description, /record_valuation/);

    const hist = byName.get("get_historical_price");
    assert.ok(hist, "get_historical_price missing");
    assert.equal(hist.annotations.readOnlyHint, true);
    assert.deepEqual([...hist.inputSchema.required].sort(), ["date", "ticker"]);

    const snap = byName.get("snapshot_eofy_valuations");
    assert.ok(snap, "snapshot_eofy_valuations missing");
    assert.equal(snap.annotations.readOnlyHint, false);
    assert.equal(snap.annotations.destructiveHint, false);
    assert.deepEqual([...snap.inputSchema.required].sort(), ["financial_year", "fund_id"]);
    assert.match(snap.description, /Unlisted/);
  } finally {
    await client.close();
  }
});
