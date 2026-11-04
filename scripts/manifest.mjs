#!/usr/bin/env node
// Keeps manifest.json's `tools` array in step with the tools the server registers.
//
//   node scripts/manifest.mjs          rewrite manifest.json from the built server
//   node scripts/manifest.mjs --check  exit 1 if manifest.json is out of date
//
// Boots dist/index.js over stdio (no API calls) and lists its tools. Order follows
// registration order. A tool already in the manifest keeps its hand-written short
// description; a new tool gets the first sentence of its registered description.
// Also checks that package.json, manifest.json and the server agree on the version.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "manifest.json");
const check = process.argv.includes("--check");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/index.js")],
  env: { ...process.env, BEESWAX_API_TOKEN: "manifest-check", BEESWAX_URL: "http://127.0.0.1:1" },
  stderr: "ignore"
});
const client = new Client({ name: "manifest-sync", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const serverVersion = client.getServerVersion()?.version;
await client.close();

const existing = new Map((manifest.tools ?? []).map((t) => [t.name, t.description]));
// First sentence of the registered description, ignoring "e.g." / "i.e." and
// keeping it short: a long sentence is cut at its first dash clause or word.
const firstSentence = (text = "") => {
  const s = text.replace(/\s+/g, " ").trim();
  const masked = s.replace(/\b(e\.g|i\.e|etc|vs)\./g, (m) => m.replace(/\./g, "\u0000"));
  const m = masked.match(/^(.+?[.!?])(\s|$)/);
  let out = (m ? m[1] : masked).replace(/\u0000/g, ".");
  if (out.length > 120 && out.includes(" — ")) out = `${out.split(" — ")[0]}.`;
  if (out.length > 120) out = `${out.slice(0, 117).replace(/\s+\S*$/, "")}…`;
  return out;
};
const generated = tools.map((t) => ({ name: t.name, description: existing.get(t.name) ?? firstSentence(t.description) }));

const problems = [];
if (pkg.version !== manifest.version) problems.push(`package.json ${pkg.version} ≠ manifest.json ${manifest.version}`);
if (serverVersion !== pkg.version) problems.push(`server reports ${serverVersion} ≠ package.json ${pkg.version} (src/version.ts reads package.json)`);

const registered = new Set(tools.map((t) => t.name));
const missing = generated.filter((t) => !existing.has(t.name)).map((t) => t.name);
const stale = [...existing.keys()].filter((n) => !registered.has(n));
const orderDiffers = JSON.stringify((manifest.tools ?? []).map((t) => t.name)) !== JSON.stringify(generated.map((t) => t.name));

if (check) {
  if (missing.length) problems.push(`manifest.json is missing ${missing.length} tool(s): ${missing.join(", ")}`);
  if (stale.length) problems.push(`manifest.json lists unregistered tool(s): ${stale.join(", ")}`);
  if (!missing.length && !stale.length && orderDiffers) problems.push("manifest.json tool order differs from registration order");
  if (manifest.tools_generated !== false) problems.push('"tools_generated" should be false (the list is static)');
  if (problems.length) {
    console.error(`manifest check failed:\n  - ${problems.join("\n  - ")}\nRun: npm run manifest`);
    process.exit(1);
  }
  console.log(`manifest OK: ${tools.length} tools, v${pkg.version}`);
} else {
  // Rewrite only the tools array and version in place, one tool per line like the
  // hand-maintained file, so the rest of manifest.json keeps its formatting.
  const toolsJson = generated
    .map((t) => `    { "name": ${JSON.stringify(t.name)}, "description": ${JSON.stringify(t.description)} }`)
    .join(",\n");
  const text = manifestText
    .replace(/"tools": \[[\s\S]*?\n  \]/, `"tools": [\n${toolsJson}\n  ]`)
    .replace(/^(  "version": )"[^"]*"/m, `$1${JSON.stringify(pkg.version)}`);
  await writeFile(manifestPath, text);
  console.log(`manifest.json: ${tools.length} tools (${missing.length} added, ${stale.length} removed), v${pkg.version}`);
  const serverProblem = problems.find((p) => p.startsWith("server"));
  if (serverProblem) console.warn(`warning: ${serverProblem}`);
}
