#!/usr/bin/env bash
# One-step release of the MCP server:
#   npm run release -- 1.4.0      (or patch | minor | major)
# Bumps package.json + package-lock.json + manifest.json together, regenerates
# manifest.json's tool list from the built server, runs the tests, and packs
# build/beeswax-shares-<version>.mcpb. Commit package.json, package-lock.json and
# manifest.json afterwards; the .mcpb is a build artifact (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:?usage: npm run release -- <version|patch|minor|major>}"
npm version "$bump" --no-git-tag-version --allow-same-version >/dev/null
rm -rf dist
npm run manifest          # build + rewrite manifest.json tools and version
npm test                  # build + manifest --check + tests
npm run pack:mcpb
