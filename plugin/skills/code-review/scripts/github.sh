#!/usr/bin/env bash
#
# github.sh — the PR's comment threads that live on GitHub: read them, and
# start a local record for one so that you can write in it. Reads only;
# nothing here writes to GitHub — publish.sh does, on `draft`.
#
# A GitHub thread is named "gh:<node id>". That is also the id of its local
# record in threads.json, when it has one (see threads.sh).
#
# Usage:
#   github.sh open <scratch>                 every unresolved thread of the PR, as JSON
#   github.sh thread <scratch> <thread-id>   one thread, as JSON; the id is "gh:<node id>" or the id
#                                            of a local thread that is already published
#   github.sh reply <scratch> <gh:node-id> [--finding]
#                                            add your comment to a GitHub thread (body on stdin), as
#                                            `threads.sh reply` does; starts the local record when
#                                            there is none yet
#
# A thread in the output:
#   { "id": "gh:…",          the thread on GitHub
#     "local": "t-…" | null, the local thread it belongs to: a finding or a comment published from
#                            this review ("t-…"), a local record of a GitHub thread ("gh:…"), or none
#     "mine": true,          the user started it
#     "bot": true,           a bot started it
#     "path": "src/x.ts", "line": 42, "side": "RIGHT",
#     "resolved": false,
#     "outdated": true,      the code under it changed since it was written; `line` is where it was
#     "comments": [ { "author": "login", "body": "…", "at": "…", "draft": true } ] }
# `draft` marks a comment of the reviewer's pending review: the author has not
# seen it yet.
#
# Environment, set by the task skill, whose scratch serves several PRs:
#   AJMO_PR_URL   the PR, instead of <scratch>/pr.url
#   AJMO_ROOT     the worktree a record started by `reply` belongs to
#
# Exit codes: 0 ok · 1 a GitHub call failed · 2 no pr.url in the scratch
#             · 3 gh or jq missing · 4 bad usage or unknown thread

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$*"; exit "$code"; }
usage() { die 4 "Usage: github.sh open|thread|reply <scratch> [...] — see the header."; }

command -v jq >/dev/null 2>&1 || die 3 "jq is required but was not found."
command -v gh >/dev/null 2>&1 || die 3 "GitHub CLI (gh) is required but was not found. Install it: https://cli.github.com/"

cmd="${1:-}"; scratch="${2:-}"
[ -n "$cmd" ] && [ -n "$scratch" ] || usage
[ -d "$scratch" ] || die 4 "No such scratch folder: $scratch"
[ -n "${AJMO_PR_URL:-}" ] || [ -s "$scratch/pr.url" ] || die 2 "No pr.url in $scratch."
file="$scratch/threads.json"
here="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

url="${AJMO_PR_URL:-$(cat "$scratch/pr.url")}"
rest="${url#*://}"; host="${rest%%/*}"; rest="${rest#*/}"
owner="${rest%%/*}"; rest="${rest#*/}"; repo="${rest%%/*}"; num="${url##*/}"

load() { if [ -s "$file" ]; then cat "$file"; else printf '{"version":1,"cursor":0,"threads":[]}\n'; fi; }

# gql <query> <variables-json> — print the response; fail on any error.
gql() {
  local out
  if ! out="$(jq -n --arg q "$1" --argjson v "$2" '{query: $q, variables: $v}' \
      | gh api graphql --hostname "$host" --method POST --input - 2>&1)"; then
    die 1 "GitHub API error: $(printf '%s\n' "$out" | tail -n 1)"
  fi
  if jq -e '.errors | length > 0' <<<"$out" >/dev/null 2>&1; then
    die 1 "GitHub API error: $(jq -r '.errors[0].message' <<<"$out")"
  fi
  printf '%s\n' "$out"
}

FIELDS='id isResolved isOutdated path line originalLine diffSide
  comments(first: 100) { nodes { author { __typename login } body createdAt state } }'

# shape — a thread node as documented in the header; $me is the reviewer, $locals the local threads.
SHAPE='def shape($me; $locals):
  . as $n
  | { id: ("gh:" + $n.id),
      local: (first($locals[] | select(.state != "dropped") | select((.github.thread // "") == $n.id) | .id) // null),
      mine: (($n.comments.nodes[0].author.login // "") == $me),
      bot: (($n.comments.nodes[0].author.__typename // "") == "Bot"),
      path: $n.path, line: ($n.line // $n.originalLine // 1),
      side: (if $n.diffSide == "LEFT" then "LEFT" else "RIGHT" end),
      resolved: $n.isResolved, outdated: $n.isOutdated,
      comments: [ $n.comments.nodes[] | { author: (.author.login // "ghost"), body: .body, at: .createdAt }
                  + (if .state == "PENDING" then { draft: true } else {} end) ] };'

# one <node id> — a single thread, shaped.
one() {
  local raw
  raw="$(gql "query(\$id: ID!) { viewer { login } node(id: \$id) { ... on PullRequestReviewThread { $FIELDS } } }" \
    "$(jq -n --arg id "$1" '{id: $id}')")"
  jq -e '.data.node.id != null' <<<"$raw" >/dev/null || die 4 "No such thread on GitHub: gh:$1"
  jq --argjson locals "$(load | jq -c '.threads')" "$SHAPE"' .data.viewer.login as $me | .data.node | shape($me; $locals)' <<<"$raw"
}

case "$cmd" in
  open)
    raw="$(gql "query(\$o: String!, \$r: String!, \$n: Int!) { viewer { login }
        repository(owner: \$o, name: \$r) { pullRequest(number: \$n) { reviewThreads(first: 100) { nodes { $FIELDS } } } } }" \
      "$(jq -n --arg o "$owner" --arg r "$repo" --argjson n "$num" '{o: $o, r: $r, n: $n}')")"
    jq --argjson locals "$(load | jq -c '.threads')" "$SHAPE"'
      .data.viewer.login as $me
      | [ .data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved | not) | select(.comments.nodes | length > 0) | shape($me; $locals) ]' <<<"$raw"
    ;;

  thread)
    tid="${3:-}"; [ -n "$tid" ] || usage
    case "$tid" in
      gh:*) node="${tid#gh:}" ;;
      *)    node="$(load | jq -r --arg t "$tid" 'first(.threads[] | select(.id == $t) | .github.thread // empty) // empty')"
            [ -n "$node" ] || die 4 "Thread $tid is not on GitHub: it is local and not published yet." ;;
    esac
    one "$node"
    ;;

  reply)
    tid="${3:-}"
    case "$tid" in gh:?*) ;; *) usage ;; esac
    kind="reply"
    case "${4:-}" in "") ;; --finding) kind="finding" ;; *) usage ;; esac
    body="$(cat)"; [ -n "$body" ] || die 4 "The reply body is empty (pass it on stdin)."
    if ! load | jq -e --arg t "$tid" 'any(.threads[]; .id == $t and .state != "dropped")' >/dev/null; then
      # No local record yet (or a dropped one): start it where the thread sits on GitHub.
      t="$(one "${tid#gh:}")"
      tmp="$file.$$.tmp"
      load | jq --argjson t "$t" --arg root "${AJMO_ROOT:-}" '
        if any(.threads[]; .id == $t.id) then
          # What a dropped record still has in the draft stays known, so the next draft removes it.
          .threads |= map(if .id == $t.id then .state = "open" | .comments = [] | del(.acked) else . end)
        else
          .threads += [ ({ id: $t.id, path: $t.path, line: $t.line, side: $t.side, state: "open", comments: [],
                           github: { thread: ($t.id | ltrimstr("gh:")), comments: {} } }
                         + (if $t.outdated then { outdated: true } else {} end)
                         + (if $root != "" then { root: $root } else {} end)) ]
        end' > "$tmp"
      mv "$tmp" "$file"
    fi
    if [ "$kind" = finding ]; then
      printf '%s' "$body" | bash "$here/threads.sh" reply "$scratch" "$tid" --finding
    else
      printf '%s' "$body" | bash "$here/threads.sh" reply "$scratch" "$tid"
    fi
    ;;

  *) usage ;;
esac
