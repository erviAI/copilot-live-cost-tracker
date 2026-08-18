#!/usr/bin/env bash
# Dispatch a workflow on a ref and block until that run finishes.
#
# Pushes, pull requests and releases authored with GITHUB_TOKEN do not start
# workflow runs, so the release train drives each downstream workflow itself.
# workflow_dispatch is the documented exception that does create a run.
#
# Usage: dispatch-and-wait.sh <workflow-file> <ref> [expected-head-sha]
set -euo pipefail

WORKFLOW="$1"
REF="$2"
EXPECTED_SHA="${3:-}"

list_runs() {
  gh run list --workflow "$WORKFLOW" --branch "$REF" --event workflow_dispatch \
    --limit 20 --json databaseId
}

# Dispatching returns no run id, so remember the newest run and wait for a newer one.
baseline="$(list_runs | jq '[.[].databaseId] | max // 0')"

gh workflow run "$WORKFLOW" --ref "$REF"
echo "Dispatched $WORKFLOW on $REF (newest existing run: $baseline)"

run_id=""
for _ in $(seq 1 60); do
  sleep 5
  run_id="$(list_runs | jq -r --argjson base "$baseline" \
    '[.[] | select(.databaseId > $base)] | sort_by(.databaseId) | last | .databaseId // empty')"
  if [ -n "$run_id" ]; then break; fi
done

if [ -z "$run_id" ]; then
  echo "::error::No new $WORKFLOW run appeared for $REF within 5 minutes."
  exit 1
fi

# Proves the checks apply to the exact commit that is about to be merged.
if [ -n "$EXPECTED_SHA" ]; then
  actual="$(gh run view "$run_id" --json headSha --jq .headSha)"
  if [ "$actual" != "$EXPECTED_SHA" ]; then
    echo "::error::Run $run_id ran against $actual but $EXPECTED_SHA was expected."
    exit 1
  fi
fi

echo "Watching $(gh run view "$run_id" --json url --jq .url)"
gh run watch "$run_id" --exit-status
