#!/usr/bin/env bash
# Builds a production-only Desktop Extension: compiled dist/, manifest.json and
# production node_modules — no TypeScript sources, tests or dev dependencies.
#   npm run pack:mcpb   → build/beeswax-shares-<version>.mcpb
# Always rebuilds dist/ from source first, and removes every other bundle in build/
# so an old (or unversioned) .mcpb can't be installed by mistake.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
npm run build
node scripts/manifest.mjs --check

version=$(node -p 'require("./package.json").version')
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -R manifest.json package.json package-lock.json README.md dist "$stage"/
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)

mkdir -p build
out="build/beeswax-shares-${version}.mcpb"
find build -maxdepth 1 -name '*.mcpb' ! -name "$(basename "$out")" -print -delete | sed 's/^/removed stale bundle: /'
rm -f beeswax-shares-*.mcpb   # bundles from before build/ existed
npx --yes @anthropic-ai/mcpb@2 pack "$stage" "$out"
echo "Built $(pwd)/$out (v${version}, $(node -p 'require("./manifest.json").tools.length') tools)"
