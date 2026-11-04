#!/usr/bin/env bash
# Publishes the MCP server as it is on origin/main to the public steamau/beeswax-desktop
# repo. Alpha's "Download extension" button (PagesController::CLAUDE_EXTENSION_URL)
# fetches releases/latest/download/beeswax-shares.mcpb from there, so a version isn't
# live for trustees until this has run.
#   npm run publish:desktop                       (after the release PR is merged)
#   npm run publish:desktop -- --notes-file notes.md
#
# 1. Exports mcp-server/ from origin/main (never the working tree) and builds the
#    bundle from that export with scripts/pack-mcpb.sh.
# 2. Mirrors the exported source into beeswax-desktop, commits "Sync v<version>",
#    tags v<version> and pushes.
# 3. Creates the GitHub release v<version>, marked latest, with the bundle attached as
#    beeswax-shares.mcpb (the asset name the download URL expects).
# 4. Checks the download URL now redirects to v<version>.
# Refuses a version that already has a release.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="steamau/beeswax-desktop"
download="https://github.com/${repo}/releases/latest/download/beeswax-shares.mcpb"
notes_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file) notes_file="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git fetch -q origin main
src_commit=$(git rev-parse --short origin/main)
top=$(git rev-parse --show-toplevel)
prefix=$(git rev-parse --show-prefix)   # "mcp-server/"
mkdir "$work/src"
git -C "$top" archive origin/main "$prefix" | tar -x -C "$work/src" --strip-components=1

version=$(node -p "require('$work/src/package.json').version")
tag="v${version}"
if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  echo "${repo} already has ${tag}. Bump the version with npm run release and merge it first." >&2
  exit 1
fi

echo "Building ${tag} from origin/main ${src_commit}"
(cd "$work/src" && npm ci --no-audit --no-fund --silent && bash scripts/pack-mcpb.sh)
bundle="$work/src/build/beeswax-shares-${version}.mcpb"
bundled=$(unzip -p "$bundle" manifest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
[ "$bundled" = "$version" ] || { echo "bundle says ${bundled}, package.json says ${version}" >&2; exit 1; }

# Default notes: the mcp-server commits since the previous release was published.
if [ -z "$notes_file" ]; then
  since=$(gh release view -R "$repo" --json publishedAt -q .publishedAt 2>/dev/null || true)
  notes_file="$work/notes.md"
  {
    echo "Beeswax Shares for Claude Desktop ${tag} ($(node -p "require('$work/src/manifest.json').tools.length") tools)."
    echo
    git log --no-merges --format='- %s' ${since:+--since="$since"} origin/main -- . | grep -viE 'rubocop' || true
    echo
    echo "Install: download \`beeswax-shares.mcpb\`, open it in Claude Desktop and click Install."
  } > "$notes_file"
fi

# Mirror the exported source (tracked files only) into the public repo.
gh repo clone "$repo" "$work/desktop" -- -q
find "$work/desktop" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$top" archive origin/main "$prefix" | tar -x -C "$work/desktop" --strip-components=1
(
  cd "$work/desktop"
  git add -A
  if git diff --cached --quiet; then
    echo "Source unchanged since the last sync."
  else
    git commit -q -m "Sync ${tag}" -m "From steamau/beeswax-shares ${src_commit} (mcp-server/)."
  fi
  git tag "$tag"
  git push -q origin HEAD "$tag"
)

cp "$bundle" "$work/beeswax-shares.mcpb"
gh release create "$tag" "$work/beeswax-shares.mcpb" -R "$repo" --title "$tag" --notes-file "$notes_file" --latest

location=$(curl -sI "$download" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
case "$location" in
  */download/${tag}/beeswax-shares.mcpb) echo "Live: ${download} -> ${tag}" ;;
  *) echo "Release created, but ${download} redirects to '${location}', not ${tag}." >&2; exit 1 ;;
esac
