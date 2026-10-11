#!/usr/bin/env bash
# Build an immutable release directory from ONE commit. Touches nothing in production.
#   build-release.sh <sha> [repo]
set -euo pipefail
sha="${1:?usage: build-release.sh <sha> [repo]}"
repo="${2:-/srv/icos/repo}"
root="${RELEASES_ROOT:-/srv/icos/releases}"
full=$(git -C "$repo" rev-parse --verify "$sha^{commit}")
dir="$root/${full:0:7}"
if [[ -e "$dir" ]]; then
  echo "release exists: $dir ($(cat "$dir/RELEASE_SHA" 2>/dev/null || echo '?')) — releases are immutable; remove it by hand to rebuild" >&2
  exit 1
fi
mkdir -p "$dir"
# git archive: the committed tree only — no worktree state, no untracked file, no .git.
git -C "$repo" archive "$full" | tar -x -C "$dir"
echo "$full" > "$dir/RELEASE_SHA"
cd "$dir"
pnpm install --frozen-lockfile --offline
NODE_ENV=production pnpm build
echo "release built: $dir"
