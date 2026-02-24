#!/usr/bin/env bash
set -euo pipefail

# Pull latest RustDesk history and show candidate stability commits
# for keyboard/audio/compatibility integration into OpenLink.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUSTDESK_REF="${1:-}"
KEYWORDS="${2:-keyboard|audio|compat|signal|api}"

cd "$REPO_ROOT"

if ! git remote | grep -qx "rustdesk"; then
  echo "Adding missing remote: rustdesk -> git@github.com:Raywonder/rustdesk.git"
  git remote add rustdesk git@github.com:Raywonder/rustdesk.git
fi

echo "Fetching rustdesk remote..."
git fetch rustdesk

if [[ -z "$RUSTDESK_REF" ]]; then
  if git rev-parse --verify --quiet rustdesk/main >/dev/null; then
    RUSTDESK_REF="rustdesk/main"
  elif git rev-parse --verify --quiet rustdesk/master >/dev/null; then
    RUSTDESK_REF="rustdesk/master"
  else
    echo "Could not detect rustdesk default branch after fetch."
    exit 1
  fi
fi

echo "Using ref: $RUSTDESK_REF"
echo
echo
echo "Candidate commits from $RUSTDESK_REF matching: $KEYWORDS"
git log "$RUSTDESK_REF" --oneline --no-merges -i --grep "$KEYWORDS" -n 60 || true

echo
echo "Next step:"
echo "  git cherry-pick <commit_sha>"
echo "or:"
echo "  git checkout -b rustdesk-sync-<topic> $RUSTDESK_REF"
