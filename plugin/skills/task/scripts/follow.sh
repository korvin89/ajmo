#!/usr/bin/env bash
#
# follow.sh — the state of a whole task, and the watcher over its open PRs.
#
# Usage:
#   follow.sh status <key>    JSON, one entry per unit: slug, branch, worktree,
#                             PR, CI (ci.sh state), manual steps; plus the
#                             parked events. The source of truth after a
#                             context compaction
#   follow.sh watch <key> [--interval S] [--max-interval S] [--quiet S]
#                             watch every unit with an open PR and print one line:
#     MERGED <pr>             merged       } announced once; that PR is not
#     CLOSED <pr>             closed       } polled again
#     READY <pr>              the author moved it out of draft
#     CONFLICTS <pr>          the base conflicts
#     CI_FAILED <pr> <checks> failed checks, none of them parked on this head
#     CI_DONE <pr>            every check passed on the head (announced once per head)
#     COMMENTS <pr> <n>       n new comments by other people (review threads,
#                             review bodies, PR comments) since the last time
#                             this line was printed, once they stop coming for
#                             --quiet seconds. News only: nothing is to be
#                             done about them until the user says so
#     AUTH … / ERROR …        as in lib/watch.sh
#   The watch runs until it has something to say; polls back off from
#   --interval (20) to --max-interval (300).
#
# Parked events (task.sh park) stay quiet while their lift has not changed:
#   head:<sha>      the PR head
#   base:<sha>      the base branch head on GitHub (baseRefOid)
# Park ids: ci:<pr>:<check>, conflict:<pr>.
#
# Exit codes: 0 ok · 1 GitHub error · 4 bad usage · 9 the task is driven by
#             another session

set -euo pipefail
. "$(dirname "$0")/common.sh"
. "$TASK_LIB/watch.sh"

usage() { die 4 "Usage: follow.sh status|watch <key> [options]"; }
[ $# -ge 2 ] || usage
cmd="$1"; KEY="$2"; shift 2
[ -f "$(task_dir "$KEY")/task.json" ] || die 4 "No task $KEY in this repository."
gh_require; gh_tmp_init; trap 'rm -rf "$GH_TMP"; watch_release' EXIT
HERE="$(dirname "$0")"
LEDGER="$(task_dir "$KEY")/ledger.json"

# open_units — "<worktree>\t<pr>" for every unit with an open PR and a worktree,
# leaving out PRs already announced as merged or closed.
open_units() {
  jq -r --slurpfile l "$LEDGER" '($l[0].ended // {}) as $e
    | .units[] | select(.pr != null and .worktree != null and .status != "done" and ($e[.pr] == null))
    | "\(.worktree)\t\(.pr)"' "$(task_dir "$KEY")/task.json"
}

# parked <id> <head> <base> — true while that event is parked and its lift holds.
parked() {
  jq -e --arg id "$1" --arg head "$2" --arg base "$3" '
    any(.parked[]; .id == $id and (
      (.lift | startswith("head:") and .[5:] == $head) or
      (.lift | startswith("base:") and .[5:] == $base)))' "$LEDGER" >/dev/null
}

ledger_set() { ledger_update "$KEY" "$@"; }

# others <pr> — how many comments other people have left on the PR: comments
# in review threads, review bodies, PR comments. A bot's PR comment (a preview
# link, a test report on every push) does not count; a bot's review thread does.
others() {
  local rest url="$1"
  rest="${url#*://}"; PR_HOST="${rest%%/*}"; rest="${rest#*/}"
  PR_OWNER="${rest%%/*}"; rest="${rest#*/}"; PR_REPO="${rest%%/*}"; PR_NUM="${url##*/}"
  gql 'query($o: String!, $r: String!, $n: Int!) { viewer { login } repository(owner: $o, name: $r) { pullRequest(number: $n) {
      reviewThreads(last: 100) { nodes { comments(first: 100) { nodes { author { login } } } } }
      reviews(last: 50) { nodes { body author { login } } }
      comments(last: 100) { nodes { author { __typename login } } } } } }' \
    "$(jq -n --arg o "$PR_OWNER" --arg r "$PR_REPO" --argjson n "$PR_NUM" '{o: $o, r: $r, n: $n}')" \
    | jq '.data.viewer.login as $me | .data.repository.pullRequest as $p
        | ([$p.reviewThreads.nodes[].comments.nodes[] | select(.author.login != $me)] | length)
          + ([$p.reviews.nodes[] | select(.author.login != $me and ((.body // "") | length) > 0)] | length)
          + ([$p.comments.nodes[] | select(.author.login != $me and .author.__typename != "Bot")] | length)'
}

task_probe() {
  local wt pr ci base head n seen fp="" news=0 failed
  while IFS=$'\t' read -r wt pr; do
    [ -n "$wt" ] || continue
    ci="$(bash "$HERE/ci.sh" state "$wt")" || return 1
    head="$(jq -r .head <<<"$ci")"; base="$(jq -r '.base // ""' <<<"$ci")"
    case "$(jq -r .state <<<"$ci")" in
      MERGED|CLOSED)
        ledger_set '.ended = ((.ended // {}) + {($pr): $s})' --arg pr "$pr" --arg s "$(jq -r .state <<<"$ci")"
        printf 'NOW\t%s %s\n' "$(jq -r .state <<<"$ci")" "$pr"; return 0 ;;
    esac
    if [ "$(jq -r .draft <<<"$ci")" = false ] && ! jq -e --arg pr "$pr" 'any(.ready[]?; . == $pr)' "$LEDGER" >/dev/null; then
      ledger_set '.ready = ((.ready // []) + [$pr])' --arg pr "$pr"
      printf 'NOW\tREADY %s\n' "$pr"; return 0
    fi
    if [ "$(jq -r .mergeable <<<"$ci")" = CONFLICTING ] && ! parked "conflict:$pr" "$head" "$base"; then
      printf 'NOW\tCONFLICTS %s\n' "$pr"; return 0
    fi
    failed="$(jq -r '.summary.failed[]' <<<"$ci" | while IFS= read -r c; do
                parked "ci:$pr:$c" "$head" "$base" || printf '%s,' "$c"; done)"
    if [ -n "$failed" ]; then
      printf 'NOW\tCI_FAILED %s %s\n' "$pr" "${failed%,}"; return 0
    fi
    if jq -e '.summary.green' <<<"$ci" >/dev/null \
       && ! jq -e --arg pr "$pr" --arg h "$head" '(.ci_done // {})[$pr] == $h' "$LEDGER" >/dev/null; then
      ledger_set '.ci_done = ((.ci_done // {}) + {($pr): $h})' --arg pr "$pr" --arg h "$head"
      printf 'NOW\tCI_DONE %s\n' "$pr"; return 0
    fi
    # Other people's comments: only the first PR with news is announced; the
    # next watch picks up the others.
    if [ "$news" -eq 0 ]; then
      n="$(others "$pr")" || return 1
      seen="$(jq -r --arg pr "$pr" '(.comments_seen // {})[$pr] // "none"' "$LEDGER")"
      if [ "$seen" = none ]; then
        # The first look at this PR: what is there already is not news.
        ledger_set '.comments_seen = ((.comments_seen // {}) + {($pr): $n})' --arg pr "$pr" --argjson n "$n"
      elif [ "$n" -gt "$seen" ]; then
        news=$((n - seen)); fp="$pr:$n"; WAIT_PR="$pr"
        printf '%s\t%s\n' "$pr" "$n" > "$GH_TMP/comments"
      elif [ "$n" -lt "$seen" ]; then
        ledger_set '.comments_seen[$pr] = $n' --arg pr "$pr" --argjson n "$n"
      fi
    fi
  done < <(open_units)
  [ "$news" -eq 0 ] || printf 'WAIT\t%s\tCOMMENTS %s %s\n' "$fp" "$WAIT_PR" "$news"
}

case "$cmd" in
  status)
    [ $# -eq 0 ] || usage
    units="[]"
    while IFS= read -r u; do
      wt="$(jq -r '.worktree // empty' <<<"$u")"; pr="$(jq -r '.pr // empty' <<<"$u")"
      if [ -n "$wt" ] && [ -n "$pr" ]; then
        ci="$(bash "$HERE/ci.sh" state "$wt" 2>/dev/null || echo null)"
        st="$(bash "$HERE/pr.sh" steps "$wt" 2>/dev/null || echo null)"
      else
        ci=null; st=null
      fi
      units="$(jq -c --argjson u "$u" --argjson ci "$ci" --argjson st "$st" \
        '. + [$u + {ci: $ci, steps: $st}]' <<<"$units")"
    done < <(task_get "$KEY" '.units[] | @json')
    jq -n --argjson t "$(cat "$(task_dir "$KEY")/task.json")" --argjson units "$units" --argjson l "$(cat "$LEDGER")" \
      '{key: $t.key, source: $t.source, base: $t.base, checks: $t.checks, units: $units, parked: $l.parked}' ;;

  watch)
    WATCH_INTERVAL=20; WATCH_MAX_INTERVAL=300
    while [ $# -gt 0 ]; do
      case "$1" in
        --interval)     WATCH_INTERVAL="${2:-}" ;;
        --max-interval) WATCH_MAX_INTERVAL="${2:-}" ;;
        --quiet)        WATCH_QUIET="${2:-}" ;;
        *)              usage ;;
      esac
      case "${2:-}" in ''|*[!0-9]*) die 4 "$1 needs a whole number of seconds." ;; esac
      shift 2
    done
    task_lock "$KEY"
    watch_pid "$(task_dir "$KEY")/watch-task.pid"
    WAIT_PR=""
    rc=0
    watch_loop task_probe > "$GH_TMP/line" || rc=$?
    cat "$GH_TMP/line"
    # Comments just announced are not news next time.
    if grep -q '^COMMENTS ' "$GH_TMP/line" && [ -s "$GH_TMP/comments" ]; then
      IFS=$'\t' read -r cpr cn < "$GH_TMP/comments"
      ledger_set '.comments_seen = ((.comments_seen // {}) + {($pr): $n})' --arg pr "$cpr" --argjson n "$cn"
    fi
    exit "$rc" ;;

  *) usage ;;
esac
