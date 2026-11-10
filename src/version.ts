import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The one place the server's version comes from: package.json, which ships in the
// .mcpb next to dist/. `npm run release` bumps it (and manifest.json) together.
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
};

export const SERVER_NAME = "beeswax-shares";
export const SERVER_VERSION: string = pkg.version;

// What changed in this release; server_info reports it. Keep in step with CHANGELOG.md.
export const RELEASE_NOTES =
  "1.15.1: the server instructions now carry a no-financial-advice rule. Beeswax doesn't hold an Australian " +
  "financial services licence, so the assistant reports the fund's figures and how they are calculated, and " +
  "doesn't recommend buying, selling or holding an investment, rank strategies or scenarios, or say whether a " +
  "balance is enough to retire on. Calculator results are stated with their assumptions. No tools changed.";

// Tools added in this release; server_info lists them.
export const NEW_TOOLS: string[] = [];
