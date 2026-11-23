#!/usr/bin/env bash
#
# discussion.sh — the review discussion of a task unit's PR, for the IDE
# flow. The user reads the reviewers' threads in VS Code and says there what
# to do; this script is how you read those threads and put replies into the
# user's pending review. It wraps the review skill's github.sh and publish.sh
# for the unit that owns <worktree>, so see their headers for the output.
#
# The task's threads — the user's comments on the lines, your notes, the local
# records of GitHub threads — are in <scratch>/threads.json, kept by the
# review skill's threads.sh; a thread's "root" is the worktree it belongs to.
#
# Usage:
#   discussion.sh open <worktree>            every unresolved thread of the PR, as JSON
#   discussion.sh thread <worktree> <id>     one thread, as JSON ("gh:<node id>", or a local id
#                                            that is published)
#   discussion.sh reply <worktree> <gh:id> [--finding]
#                                            your comment in a GitHub thread (body on stdin):
#                                            a note for the user, or with --finding a reply
#                                            for the reviewer, published by `draft`
#   discussion.sh draft <worktree> [--dry-run]
#                                            put the replies written in the IDE — the user's and
#                                            yours — into the user's pending review; the user
#                                            submits it on GitHub
#   discussion.sh news <worktree>            review bodies and PR comments by other people that
#                                            have not been shown yet, as JSON:
#                                            [{id, kind: review|comment, author, bot, state, url, body}];
#                                            mark them shown with `task.sh seen <key> <id>…`
#
# Exit codes: those of github.sh and publish.sh (5 — nothing to publish), and
#             4 bad usage · 7 not a task worktree, or the unit has no PR yet

set -euo pipefail
. "$(dirname "$0")/common.sh"

usage() { die 4 "Usage: discussion.sh open|thread|reply|draft|news <worktree> [...] — see the header."; }
[ $# -ge 2 ] || usage
cmd="$1"
WT="$(CDPATH='' cd -P -- "$2" 2>/dev/null && pwd -P)" || die 4 "No such worktree: $2"
shift 2
hit="$(task_of "$WT")"; [ -n "$hit" ] || die 7 "$WT is not the worktree of a task unit."
KEY="${hit%%$'\t'*}"; IDX="${hit#*$'\t'}"
pr="$(task_get "$KEY" ".units[$IDX].pr // empty")"; [ -n "$pr" ] || die 7 "This unit has no PR yet."
scratch="$(task_dir "$KEY")"
REVIEW="$(CDPATH='' cd -P -- "$(dirname "$0")/../../code-review/scripts" && pwd)"
export AJMO_PR_URL="$pr" AJMO_ROOT="$WT"

case "$cmd" in
  open)   [ $# -eq 0 ] || usage; exec bash "$REVIEW/github.sh" open "$scratch" ;;
  thread) [ $# -eq 1 ] || usage; exec bash "$REVIEW/github.sh" thread "$scratch" "$1" ;;
  reply)  [ $# -ge 1 ] || usage; exec bash "$REVIEW/github.sh" reply "$scratch" "$@" ;;
  draft)
    case "${1:-}" in ""|--dry-run) ;; *) usage ;; esac
    [ -s "$scratch/threads.json" ] || die 5 "Nothing to publish: no threads yet."
    # The head of a task's PR is ours: there is no "moved since the review".
    exec bash "$REVIEW/publish.sh" "$scratch" --allow-moved "$@" ;;
  news)
    [ $# -eq 0 ] || usage
    gh_require; gh_tmp_init; trap 'rm -rf "$GH_TMP"' EXIT
    gh_pr "$pr" || exit 1
    raw="$(gql 'query($o: String!, $r: String!, $n: Int!) { viewer { login } repository(owner: $o, name: $r) { pullRequest(number: $n) {
        reviews(last: 50) { nodes { id fullDatabaseId state body url author { __typename login } } }
        comments(last: 100) { nodes { id fullDatabaseId body url author { __typename login } } } } } }' \
      "$(jq -n --arg o "$PR_OWNER" --arg r "$PR_REPO" --argjson n "$PR_NUM" '{o: $o, r: $r, n: $n}')")" || exit 1
    jq --argjson seen "$(jq -c '.seen' "$scratch/ledger.json")" '
      def id: (.fullDatabaseId // .id | tostring);
      def fresh: id as $i | any($seen[]; . == $i) | not;
      .data.viewer.login as $me | .data.repository.pullRequest as $p
      | [ $p.reviews.nodes[] | select(.author.login != $me and ((.body // "") | length) > 0 and fresh)
          | {id: id, kind: "review", author: .author.login, bot: (.author.__typename == "Bot"), state, url, body} ]
      + [ $p.comments.nodes[] | select(.author.login != $me and fresh)
          | {id: id, kind: "comment", author: .author.login, bot: (.author.__typename == "Bot"), state: null, url, body} ]' <<<"$raw" ;;
  *) usage ;;
esac
