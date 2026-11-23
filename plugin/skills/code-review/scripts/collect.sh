#!/usr/bin/env bash
#
# collect.sh — prepare the review of a pull request for the Ajmo extension.
#
# Usage:
#   collect.sh <PR_NUMBER | #PR_NUMBER | PR_URL>
#   collect.sh <PR> --check      only say whether the PR head moved since the review:
#                                prints "same <sha>" or "moved <reviewed sha> <head sha>";
#                                fetches nothing and changes nothing
#
# Fetches the PR head from the git remote that points at the PR's repository
# and checks it out, detached, into <scratch>/<repo>-pr-<N> — named so that the
# VS Code window opened on it says what it is. The current checkout is not
# touched. A later run for the same PR moves that worktree to the new head,
# unless it holds local changes.
#
# <scratch> is <git-common-dir>/ajmo/pr-<N>: the one place for everything this
# review leaves behind. The Ajmo extension looks there too.
#   <repo>-pr-<N>/ the PR head, a git worktree
#   checkout       the name of that folder (older reviews have none and use head/)
#   pr.url         the PR's URL
#   session        the id of the Claude Code session that runs the review
#   threads.json   review threads, written by the skill
#   inbox.jsonl    what the user wrote in the IDE, appended by the extension
#
# Output is plain text; every section starts with "### ":
#   ### TARGET: PR #N — <url>
#   ### SCRATCH: <dir>
#   ### WORKTREE: <path> (<sha>)
#   ### BASE: <branch> (<merge-base sha>)
#   ### NOTE: …                      (warnings, optional)
#   ### PR TITLE / ### PR BODY / ### EXISTING COMMENTS
#   ### CHANGED FILES
#   ### DIFF
# and, when an earlier run recorded the commit it reviewed (threads.sh reviewed):
#   ### REVIEWED: <sha>              equal to the worktree's commit: nothing new
# followed, when the head is newer than that commit, by:
#   ### COMMITS SINCE THE REVIEW
#   ### DELTA                        what changed in the PR's files since that commit
#
# Exit codes: 0 ok · 1 gh or git failed (PR not found, auth, no remote)
#             · 2 not a git repository · 3 gh or jq missing · 4 bad argument,
#             or the scratch belongs to another PR · 5 nothing to review

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$*"; exit "$code"; }

command -v gh >/dev/null 2>&1 || die 3 "GitHub CLI (gh) is required but was not found. Install it: https://cli.github.com/"
command -v jq >/dev/null 2>&1 || die 3 "jq is required but was not found."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 2 "Not inside a git repository."

# ------------------------------------------------------------- arguments ----
ref=""; check=0
for arg in "$@"; do
  a="${arg#\#}"                                              # allow "#123"
  case "$a" in
    --check)       check=1 ;;
    */pull/[0-9]*) ref="$a" ;;
    ""|*[!0-9]*)   die 4 "Unrecognised argument: '$arg'. Expected a PR number, #number, or a …/pull/N URL." ;;
    *)             ref="$a" ;;
  esac
done
[ -n "$ref" ] || die 4 "A PR reference is required: a number, #number, or a …/pull/N URL."

# ------------------------------------------------------------------ the PR --
pr_json="$(gh pr view "$ref" --json number,url,title,body,baseRefName,baseRefOid,headRefOid,state 2>&1)" \
  || die 1 "gh could not read the PR '$ref': $pr_json"
num="$(jq -r .number <<<"$pr_json")"
url="$(jq -r .url <<<"$pr_json")"
base_name="$(jq -r .baseRefName <<<"$pr_json")"
base_oid="$(jq -r .baseRefOid <<<"$pr_json")"
# https://<host>/<owner>/<repo>/pull/<n>
owner="$(printf '%s' "$url" | awk -F/ '{print $(NF-3)}')"
repo="$(printf '%s' "$url" | awk -F/ '{print $(NF-2)}')"

if [ "$check" = 1 ]; then
  dir="$(CDPATH='' cd -P -- "$(git rev-parse --git-common-dir)" && pwd -P)/ajmo/pr-$num"
  wt="$dir/$(cat "$dir/checkout" 2>/dev/null || echo head)"
  [ -e "$wt/.git" ] || die 4 "PR #$num has no review checkout here: run the review first."
  reviewed="$(git -C "$wt" rev-parse HEAD)"
  head="$(jq -r .headRefOid <<<"$pr_json")"
  if [ "$reviewed" = "$head" ]; then printf 'same %s\n' "$head"; else printf 'moved %s %s\n' "$reviewed" "$head"; fi
  exit 0
fi

# pr_remote — the git remote that points at the PR's repository.
pr_remote() {
  local want name remote_url _
  want="$(printf '/%s/%s' "$owner" "$repo" | tr '[:upper:]' '[:lower:]')"
  # Any remote URL form ends in /owner/repo once ':' is '/' and .git is gone.
  while read -r name remote_url _; do
    remote_url="$(printf '%s' "$remote_url" | tr '[:upper:]' '[:lower:]' | tr ':' '/')"
    remote_url="${remote_url%/}"; remote_url="${remote_url%.git}"
    case "$remote_url" in *"$want") printf '%s\n' "$name"; return 0 ;; esac
  done < <(git remote -v | awk '$3 == "(fetch)"')
  return 1
}
remote="$(pr_remote)" || die 1 "No git remote points at $owner/$repo. Run this from a clone of the PR's repository."

# ------------------------------------------------------------- the scratch --
common="$(CDPATH='' cd -P -- "$(git rev-parse --git-common-dir)" && pwd -P)"
scratch="$common/ajmo/pr-$num"
mkdir -p "$scratch"
if [ -f "$scratch/pr.url" ] && [ "$(cat "$scratch/pr.url")" != "$url" ]; then
  die 4 "$scratch belongs to another PR ($(cat "$scratch/pr.url")). Remove it and run again."
fi
printf '%s\n' "$url" > "$scratch/pr.url"
# The extension matches the session row to this review by its id.
[ -z "${CLAUDE_CODE_SESSION_ID:-}" ] || printf '%s\n' "$CLAUDE_CODE_SESSION_ID" > "$scratch/session"

# ------------------------------------------------------------ the worktree --
git fetch --quiet --no-tags "$remote" "pull/$num/head" 2>/dev/null \
  || die 1 "git fetch $remote pull/$num/head failed."
sha="$(git rev-parse FETCH_HEAD)"
git fetch --quiet --no-tags "$remote" "$base_name" 2>/dev/null || true

notes=()
name="$repo-pr-$num"
wt="$scratch/$name"
# A review made before the folder had a name keeps its worktree, under the new name.
if [ ! -e "$wt/.git" ] && [ -e "$scratch/head/.git" ]; then
  git worktree move "$scratch/head" "$wt" 2>/dev/null || { name="head"; wt="$scratch/head"; }
fi
printf '%s\n' "$name" > "$scratch/checkout"
if [ -e "$wt/.git" ]; then
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    notes+=("the checkout has local changes and was left at $(git -C "$wt" rev-parse --short HEAD); its files may be older than the PR")
  else
    git -C "$wt" checkout --quiet --detach "$sha"
  fi
else
  git worktree add --quiet --detach "$wt" "$sha" || die 1 "git worktree add $wt failed."
fi
at="$(git -C "$wt" rev-parse HEAD)"

base="$(git merge-base "$sha" "$base_oid" 2>/dev/null || git merge-base "$sha" "$remote/$base_name" 2>/dev/null || true)"
[ -n "$base" ] || die 1 "Could not find the merge base of the PR with $base_name."
[ -n "$(git diff --name-only "$base" "$sha")" ] || die 5 "PR #$num has no changes against $base_name."

# ------------------------------------------------------------------ output --
printf '### TARGET: PR #%s — %s\n' "$num" "$url"
printf '### SCRATCH: %s\n' "$scratch"
printf '### WORKTREE: %s (%s)\n' "$wt" "$at"
printf '### BASE: %s (%s)\n' "$base_name" "$base"
for n in ${notes[@]+"${notes[@]}"}; do printf '### NOTE: %s\n' "$n"; done
[ "$(jq -r .state <<<"$pr_json")" = OPEN ] || printf '### NOTE: the PR is %s\n' "$(jq -r '.state | ascii_downcase' <<<"$pr_json")"

printf '\n### PR TITLE\n%s\n' "$(jq -r .title <<<"$pr_json")"
printf '\n### PR BODY\n%s\n' "$(jq -r '.body // ""' <<<"$pr_json")"

printf '\n### EXISTING COMMENTS\n'
# Line comments by thread, then the PR-level comments. Best effort: a failure
# here must not stop the review.
query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:50){nodes{author{login} body state}}}}
  comments(first:100){nodes{author{login} body}}}}}'
if existing="$(gh api graphql -f query="$query" -F owner="$owner" -F name="$repo" -F number="$num" 2>/dev/null)"; then
  jq -r '
    .data.repository.pullRequest as $pr
    | ($pr.reviewThreads.nodes[] | select(.comments.nodes | length > 0)
       | "— \(.path):\(.line // .originalLine // "?")\(if .isResolved then " (resolved)" else "" end)\(if .isOutdated then " (outdated)" else "" end)",
         (.comments.nodes[] | "   \(.author.login // "ghost")\(if .state == "PENDING" then " (your draft)" else "" end): \(.body | gsub("\n"; "\n   "))")),
      ($pr.comments.nodes[] | "— PR comment by \(.author.login // "ghost"): \(.body | gsub("\n"; "\n   "))")
  ' <<<"$existing"
else
  printf '(could not load the existing comments)\n'
fi

printf '\n### CHANGED FILES\n'
git -c core.quotepath=false diff --name-status -M "$base" "$sha"
printf '\n### DIFF\n'
git -c core.quotepath=false diff -M "$base" "$sha"

# ------------------------------------------------- since the last review ----
reviewed="$(jq -r '.reviewed // ""' "$scratch/threads.json" 2>/dev/null || true)"
[ -z "$reviewed" ] || printf '\n### REVIEWED: %s\n' "$reviewed"
if [ -n "$reviewed" ] && [ "$reviewed" != "$sha" ]; then
  if ! git cat-file -e "$reviewed^{commit}" 2>/dev/null; then
    printf '### NOTE: that commit is not in the repository any more; there is no delta, review the whole diff\n'
  else
    git merge-base --is-ancestor "$reviewed" "$sha" 2>/dev/null \
      || printf '### NOTE: the branch was rebased or force-pushed since the review; the delta may show changes that came from %s\n' "$base_name"
    printf '\n### COMMITS SINCE THE REVIEW\n'
    git log --oneline --no-merges "$reviewed..$sha"
    printf '\n### DELTA\n'
    # Only the PR's own files: a merge of the base branch brings changes that are not the author's.
    files=()
    while IFS= read -r f; do files+=("$f"); done < <(git -c core.quotepath=false diff --name-only -M "$base" "$sha")
    git -c core.quotepath=false diff -M "$reviewed" "$sha" -- "${files[@]}"
  fi
fi
