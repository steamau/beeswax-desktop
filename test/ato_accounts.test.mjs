import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Boots the built server over stdio and checks the ATO account tools are
// registered with the right annotations and inputs. No API calls are made.
test("ATO account tools are registered with annotations", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "ato-accounts-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of ["list_ato_accounts", "list_ato_transactions", "get_ato_position"]) {
      assert.ok(byName.get(name), `${name} missing`);
      assert.equal(byName.get(name).annotations.readOnlyHint, true, `${name} should be read-only`);
    }
    for (const name of ["import_ato_statement", "update_ato_transaction", "match_ato_payment"]) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} missing`);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.ok(tool.inputSchema.required.includes("ato_account_id"), `${name} should require ato_account_id`);
    }
    assert.deepEqual(byName.get("match_ato_payment").inputSchema.properties.match_action.enum, ["find", "confirm", "ignore", "unmatch"]);
    assert.ok("file_path" in byName.get("import_ato_statement").inputSchema.properties);
    assert.match(byName.get("import_ato_statement").description, /Idempotent/);
  } finally {
    await client.close();
  }
});

test("ATO import undo and account creation tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" }
  });
  const client = new Client({ name: "ato-undo-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const undo = byName.get("undo_ato_import");
    assert.ok(undo, "undo_ato_import missing");
    assert.equal(undo.annotations.readOnlyHint, false);
    assert.equal(undo.annotations.destructiveHint, true);
    assert.match(undo.description, /DESTRUCTIVE/);
    for (const field of ["fund_id", "ato_account_id", "import_id"]) {
      assert.ok(undo.inputSchema.required.includes(field), `undo_ato_import should require ${field}`);
    }
    assert.equal(undo.inputSchema.properties.dry_run.type, "boolean");
    assert.equal(undo.inputSchema.properties.dry_run.default, true);
    assert.ok(!undo.inputSchema.required.includes("dry_run"), "dry_run is optional");
    assert.ok("reasoning" in undo.inputSchema.properties);
    assert.ok("external_ref" in undo.inputSchema.properties);

    const create = byName.get("create_ato_account");
    assert.ok(create, "create_ato_account missing");
    assert.equal(create.annotations.readOnlyHint, false);
    assert.equal(create.annotations.destructiveHint, false);
    assert.deepEqual(create.inputSchema.properties.account_type.enum, ["income_tax", "activity_statement", "superannuation"]);
    assert.ok(create.inputSchema.required.includes("account_type"));
    assert.ok("reasoning" in create.inputSchema.properties);

    assert.equal(byName.get("list_ato_imports").annotations.readOnlyHint, true);

    // Parameter validation happens before any API call.
    const bad = await client.callTool({ name: "create_ato_account", arguments: { fund_id: 2, account_type: "other" } });
    assert.equal(bad.isError, true);
    const badUndo = await client.callTool({ name: "undo_ato_import", arguments: { fund_id: 2, ato_account_id: 1, import_id: "one" } });
    assert.equal(badUndo.isError, true);
  } finally {
    await client.close();
  }
});
