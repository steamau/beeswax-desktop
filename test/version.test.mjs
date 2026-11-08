import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BEESWAX_API_TOKEN: "test-token", BEESWAX_URL: "http://127.0.0.1:1" },
    stderr: "ignore"
  });
  const client = new Client({ name: "version-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

// Independent of scripts/manifest.mjs: compares the bundle's static tool list with
// what the built server actually registers, so a stale manifest fails CI.
test("manifest.json tools and version match the registered tools", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      manifest.tools.map((t) => t.name),
      tools.map((t) => t.name),
      "manifest.json tools differ from registered tools — run npm run manifest"
    );
    assert.equal(manifest.version, pkg.version, "manifest.json version ≠ package.json");
    assert.equal(client.getServerVersion()?.version, pkg.version, "server version ≠ package.json");
  } finally {
    await client.close();
  }
});

test("server_info reports the version without calling the API", async () => {
  const client = await connect();
  try {
    const res = await client.callTool({ name: "server_info", arguments: {} });
    const info = JSON.parse(res.content[0].text);
    assert.equal(info.name, "beeswax-shares");
    assert.equal(info.version, pkg.version);
    assert.match(info.release_notes, new RegExp(`^${pkg.version.replaceAll(".", "\\.")}:`), "release_notes should lead with this version");
    assert.equal(info.tool_count, manifest.tools.length);
    assert.equal(info.api_base_url, "http://127.0.0.1:1");
  } finally {
    await client.close();
  }
});
