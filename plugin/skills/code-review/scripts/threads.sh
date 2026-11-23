#!/usr/bin/env bash
#
# threads.sh — the review's thread store, shared with the Ajmo extension.
#
# Two files in <scratch>, one writer each:
#   threads.json   written only by this script: every thread, and `cursor`,
#                  the number of inbox events already folded in
#   inbox.jsonl    appended only by the extension: what the reviewer wrote in
#                  the IDE. Never write to it.
# The format is docs/review-protocol.md of the Ajmo repository.
#
# Usage:
#   threads.sh add <scratch> <batch.json>     add findings as new threads; prints "added <thread-id> <path>:<line>" per finding
#   threads.sh fold <scratch>                 fold the reviewer's new inbox events into threads.json; prints "folded <n>"
#   threads.sh pending <scratch>              threads that wait for you, as JSON
#   threads.sh reply <scratch> <thread-id> [--finding]
#                                             add your comment to a thread (body on stdin): a reply to the
#                                             reviewer, or with --finding a finding meant for the PR author
#   threads.sh ack <scratch> <thread-id>      mark a thread as handled without replying
#   threads.sh edit <scratch> <comment-id>    replace the body of one of your comments (body on stdin)
#   threads.sh state <scratch> <thread-id> <open|published|dropped>
#   threads.sh list <scratch>                 every thread that is not dropped, as JSON
#   threads.sh wait <scratch>                 block until the reviewer presses Sync in the IDE; prints one line
#   threads.sh rebase <scratch>               after the PR head moved: carry the threads over to the new code
#   threads.sh place <scratch> <thread-id> <line>
#                                             put a thread on a line of the current code and clear its outdated mark
#   threads.sh reviewed <scratch>             record that the code is reviewed up to the commit the worktree is on
#
# batch.json for add:
#   { "comments": [ { "path": "src/x.ts", "line": 42, "body": "🔴 **blocker** — …" } ] }
#   `line` is a 1-based line of the file at the PR head. Add "side": "LEFT" for
#   a line of the base file. Two optional top-level fields, used by the task
#   skill: "root": "<worktree>" — the worktree the paths are in, when the
#   scratch serves several; "talk": true — the comments are notes for the
#   user ("kind": "reply"), never published.
#
# Your comments have a kind: "finding" (from add, or reply --finding) is meant
# for the PR author and is what `draft` will publish; "reply" is talk with the
# reviewer and is never published.
#
# A thread waits for you (pending) when its last comment is the reviewer's, is
# addressed to you ("to": "agent"), and you have not acked it. The reviewer's
# "to": "github" comments are their own review comments: never answer, edit or
# drop them on your own.
#
# A thread whose id starts with "gh:" lives on GitHub — somebody else's, or the
# reviewer's own from a submitted review. Its local record holds only what was
# written here: the reviewer's replies in it ("to": "github", published as
# replies in that thread), their questions to you about it, and your comments.
# Read the thread itself with github.sh.
#
# fold applies, in order: a comment (appended to its thread, or starting a new
# one at its anchor), an edit or a delete of one of the reviewer's comments, a
# drop of a whole thread. A thread left without comments is dropped.
#
# Lines and the PR head. A thread's `line` is a line of the file at the commit
# in `head` (top level of threads.json), the commit the review worktree was on when
# the thread was written. When collect.sh has moved that worktree to a newer
# commit, rebase maps every thread from the old commit to the new one:
#   - a line the push did not touch moves with the code to its new number;
#   - a line the push changed or removed marks the thread `outdated`: it stays
#     next to where it was and waits for a second look;
#   - a renamed file is followed; a deleted file marks its threads outdated.
# Threads on the base side ("side": "LEFT") are left as they are.
# rebase prints one line per thread it touched — "moved <id> <path>:<old> → <new>"
# or "outdated <id> <path>:<line>" — and "rebased <old sha> → <new sha>", or
# "nothing to rebase" when the head did not move.
#
# wait is the listener behind the extension's Sync button. It records its pid
# in <scratch>/wait.pid, so the extension knows somebody listens, and ends when
# the extension creates <scratch>/sync.request:
#   SYNC   the reviewer asked for a sync: run a pass, then wait again
#   DRAFT  the reviewer pressed "Post the Draft to GitHub": publish, then wait again
#   GONE   the scratch folder was removed: the review is over
# One listener per review: a second one exits 6 at once.
#
# Exit codes: 0 ok · 3 jq missing · 4 bad usage, unknown thread or comment
#             · 5 nothing to add · 6 a listener is already running

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$*"; exit "$code"; }
usage() { die 4 "Usage: threads.sh add|fold|pending|reply|ack|edit|state|list|wait|rebase|place|reviewed <scratch> [...] — see the header."; }

command -v jq >/dev/null 2>&1 || die 3 "jq is required but was not found."

cmd="${1:-}"; scratch="${2:-}"
[ -n "$cmd" ] && [ -n "$scratch" ] || usage
[ -d "$scratch" ] || die 4 "No such scratch folder: $scratch"
file="$scratch/threads.json"
inbox="$scratch/inbox.jsonl"

load() { if [ -s "$file" ]; then cat "$file"; else printf '{"version":1,"cursor":0,"threads":[]}\n'; fi; }
# save — atomic: the extension may read the file at any moment.
save() { local tmp="$file.$$.tmp"; cat > "$tmp"; mv "$tmp" "$file"; }
# head_sha — the commit the review worktree is on, or nothing without one.
# checkout — the review worktree: the folder collect.sh named in <scratch>/checkout, or head/.
checkout() { printf '%s/%s' "$scratch" "$(cat "$scratch/checkout" 2>/dev/null || echo head)"; }
head_sha() { [ -e "$(checkout)/.git" ] && git -C "$(checkout)" rev-parse HEAD 2>/dev/null || true; }
# stamp — record that commit as the one the threads' lines refer to, unless one is recorded.
stamp() { jq --arg h "$(head_sha)" 'if (.head // "") == "" and $h != "" then .head = $h else . end'; }
new_id() { printf '%s-%s' "$1" "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# events — the inbox as a JSON array of valid events. The extension skips the
# same lines (torn or malformed), so both sides count the cursor alike.
events() {
  if [ -s "$inbox" ]; then
    jq -Rn '[inputs | (try fromjson catch empty)
      | select(type == "object")
      | select((.type == "comment" and (.id | type) == "string" and (.thread | type) == "string" and (.body | type) == "string")
            or (.type == "edit" and (.comment | type) == "string" and (.body | type) == "string")
            or (.type == "delete" and (.comment | type) == "string")
            or (.type == "drop" and (.thread | type) == "string"))]' < "$inbox"
  else
    printf '[]\n'
  fi
}

case "$cmd" in
  add)
    batch="${3:-}"; [ -f "$batch" ] || usage
    n="$(jq '(.comments // []) | length' "$batch")"
    [ "$n" -gt 0 ] || die 5 "Nothing to add: the batch has no comments."
    ids="[]"
    for _ in $(seq 1 "$n"); do ids="$(jq -c --arg t "$(new_id t)" --arg c "$(new_id a)" '. + [[$t, $c]]' <<<"$ids")"; done
    load | jq --slurpfile batch "$batch" --argjson ids "$ids" --arg at "$(now)" '
      (if $batch[0].talk == true then "reply" else "finding" end) as $kind
      | .threads += [ ($batch[0].comments | to_entries[] | . as $e
        | { id: $ids[$e.key][0], path: $e.value.path, line: $e.value.line,
            side: (if $e.value.side == "LEFT" then "LEFT" else "RIGHT" end), state: "open",
            comments: [ { id: $ids[$e.key][1], author: "agent", kind: $kind, body: $e.value.body, at: $at } ] }
          + (if ($batch[0].root // "") != "" then { root: $batch[0].root } else {} end)) ]' | stamp | save
    jq -r --argjson ids "$ids" '.comments | to_entries[] | "added \($ids[.key][0]) \(.value.path):\(.value.line)"' "$batch"
    ;;

  fold)
    ev="$(events)"
    total="$(jq 'length' <<<"$ev")"
    from="$(load | jq '.cursor // 0')"
    [ "$from" -le "$total" ] || from="$total"
    load | jq --argjson ev "$ev" '
      (.cursor // 0) as $from
      | reduce ($ev[$from:][]) as $e (.;
          if $e.type == "comment" then
            { id: $e.id, author: "user", to: (if $e.to == "agent" then "agent" else "github" end), body: $e.body, at: $e.at } as $c
            | if any(.threads[]; .id == $e.thread and .state != "dropped") then
                .threads |= map(if .id == $e.thread then .comments += [$c] else . end)
              elif any(.threads[]; .id == $e.thread) and $e.anchor then
                # The reviewer writes again in a GitHub thread whose local record was dropped: it starts over.
                .threads |= map(if .id == $e.thread then .state = "open" | .comments = [$c] | del(.acked) else . end)
              elif $e.anchor then
                .threads += [ ({ id: $e.thread, path: $e.anchor.path, line: $e.anchor.line,
                                 side: (if $e.anchor.side == "LEFT" then "LEFT" else "RIGHT" end), state: "open", comments: [$c] }
                               + (if ($e.anchor.root? // "") != "" then { root: $e.anchor.root } else {} end)
                               + (if ($e.github.thread? // null) != null then { github: { thread: $e.github.thread, comments: {} } } else {} end)) ]
              else . end
          elif $e.type == "edit" then
            .threads |= map(.comments |= map(if .id == $e.comment and .author == "user" then .body = $e.body | .edited = true else . end))
          elif $e.type == "delete" then
            .threads |= map(.comments |= map(select(.id != $e.comment or .author != "user")))
          elif $e.type == "drop" then
            .threads |= map(if .id == $e.thread then .state = "dropped" else . end)
          else . end)
      | .threads |= map(if (.comments | length) == 0 then .state = "dropped" else . end)
      | .cursor = ($ev | length)' | stamp | save
    printf 'folded %s\n' "$(( total - from ))"
    ;;

  pending)
    load | jq '[ .threads[] | select(.state != "dropped")
      | select((.comments | last) as $l | $l.author == "user" and $l.to == "agent" and $l.id != .acked) ]'
    ;;

  reply)
    tid="${3:-}"; [ -n "$tid" ] || usage
    kind="reply"
    case "${4:-}" in "") ;; --finding) kind="finding" ;; *) usage ;; esac
    body="$(cat)"; [ -n "$body" ] || die 4 "The reply body is empty (pass it on stdin)."
    load | jq -e --arg t "$tid" 'any(.threads[]; .id == $t)' >/dev/null || die 4 "No such thread: $tid"
    load | jq --arg t "$tid" --arg c "$(new_id a)" --arg kind "$kind" --arg body "$body" --arg at "$(now)" '
      .threads |= map(if .id == $t then .comments += [ { id: $c, author: "agent", kind: $kind, body: $body, at: $at } ] else . end)' | save
    ;;

  ack)
    tid="${3:-}"; [ -n "$tid" ] || usage
    load | jq -e --arg t "$tid" 'any(.threads[]; .id == $t)' >/dev/null || die 4 "No such thread: $tid"
    load | jq --arg t "$tid" '.threads |= map(if .id == $t then .acked = (.comments | last | .id) else . end)' | save
    ;;

  edit)
    cid="${3:-}"; [ -n "$cid" ] || usage
    body="$(cat)"; [ -n "$body" ] || die 4 "The new body is empty (pass it on stdin)."
    load | jq -e --arg c "$cid" 'any(.threads[].comments[]; .id == $c and .author == "agent")' >/dev/null \
      || die 4 "No such comment of yours: $cid (the reviewer's comments are theirs to edit)."
    load | jq --arg c "$cid" --arg body "$body" '
      .threads |= map(.comments |= map(if .id == $c and .author == "agent" then .body = $body else . end))' | save
    ;;

  state)
    tid="${3:-}"; st="${4:-}"
    case "$st" in open|published|dropped) ;; *) usage ;; esac
    load | jq -e --arg t "$tid" 'any(.threads[]; .id == $t)' >/dev/null || die 4 "No such thread: $tid"
    load | jq --arg t "$tid" --arg st "$st" '.threads |= map(if .id == $t then .state = $st else . end)' | save
    ;;

  list)
    load | jq '[ .threads[] | select(.state != "dropped") ]'
    ;;

  place)
    tid="${3:-}"; line="${4:-}"
    case "$line" in ""|*[!0-9]*) usage ;; esac
    load | jq -e --arg t "$tid" 'any(.threads[]; .id == $t)' >/dev/null || die 4 "No such thread: $tid"
    load | jq --arg t "$tid" --argjson l "$line" '.threads |= map(if .id == $t then .line = $l | del(.outdated) else . end)' | save
    ;;

  reviewed)
    sha="$(head_sha)"; [ -n "$sha" ] || die 4 "No review worktree in $(checkout)."
    load | jq --arg h "$sha" '.reviewed = $h' | stamp | save
    printf 'reviewed %s\n' "$sha"
    ;;

  rebase)
    new="$(head_sha)"; [ -n "$new" ] || die 4 "No review worktree in $(checkout)."
    old="$(load | jq -r '.head // ""')"
    if [ -z "$old" ] || [ "$old" = "$new" ]; then
      load | jq --arg h "$new" '.head = $h' | save
      echo "nothing to rebase"; exit 0
    fi
    git -C "$(checkout)" cat-file -e "$old^{commit}" 2>/dev/null \
      || die 4 "The commit the threads were written on ($old) is not in the repository any more."
    # Zero-context hunks of every file the push touched, keyed by the old path.
    changes="$(git -C "$(checkout)" -c core.quotepath=false diff -U0 -M --no-color "$old" "$new" | jq -Rn '
      reduce inputs as $l ({cur: null, files: {}};
        if ($l | startswith("diff --git ")) then .cur = {old: null, new: null, hunks: [], gone: false}
        elif .cur == null then .
        elif ($l | startswith("rename from ")) then .cur.old = $l[12:]
        elif ($l | startswith("rename to ")) then .cur.new = $l[10:] | .files[.cur.old] = .cur
        elif ($l | startswith("--- ")) then (if $l == "--- /dev/null" then . else .cur.old = $l[6:] end)
        elif ($l | startswith("+++ ")) then
          (if $l == "+++ /dev/null" then .cur.gone = true else .cur.new = $l[6:] end)
          | (if .cur.old != null then .files[.cur.old] = .cur else . end)
        elif ($l | startswith("@@ ")) then
          ($l | capture("^@@ -(?<a>[0-9]+)(,(?<b>[0-9]+))? \\+(?<c>[0-9]+)(,(?<d>[0-9]+))? @@")) as $h
          | .cur.hunks += [{a: ($h.a | tonumber), b: (($h.b // "1") | tonumber), c: ($h.c | tonumber), d: (($h.d // "1") | tonumber)}]
          | (if .cur.old != null then .files[.cur.old] = .cur else . end)
        else . end)
      | .files')"
    before="$(load)"
    after="$(jq --argjson ch "$changes" --arg h "$new" '
      # where an old line is in the new file: [line, changed?]
      def carry($hunks; $line):
        reduce $hunks[] as $k ({delta: 0, hit: null};
          if .hit != null then .
          elif $k.b == 0 then (if $line > $k.a then .delta += $k.d else . end)
          elif $line < $k.a then .
          elif $line <= $k.a + $k.b - 1 then .hit = (if $k.c < 1 then 1 else $k.c end)
          else .delta += ($k.d - $k.b) end)
        | if .hit != null then [.hit, true] else [$line + .delta, false] end;
      .head = $h
      | .threads |= map(
          if .state == "dropped" or .side == "LEFT" or ($ch[.path] // null) == null then .
          else $ch[.path] as $f
            | if $f.gone then .outdated = true
              else carry($f.hunks; .line) as $r
                | .path = ($f.new // .path) | .line = $r[0] | (if $r[1] then .outdated = true else . end)
              end
          end)' <<<"$before")"
    printf '%s\n' "$after" | save
    jq -rn --argjson b "$before" --argjson a "$after" '
      ($b.threads | map({key: .id, value: .}) | from_entries) as $was
      | $a.threads[] | select(.state != "dropped") | . as $t | $was[.id] as $o
      | if ($t.outdated // false) and (($o.outdated // false) | not) then "outdated \($t.id) \($t.path):\($t.line)"
        elif $t.line != $o.line or $t.path != $o.path then "moved \($t.id) \($o.path):\($o.line) → \($t.line)"
        else empty end'
    printf 'rebased %s → %s\n' "$old" "$new"
    ;;

  wait)
    pidfile="$scratch/wait.pid"
    if [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      die 6 "A listener is already running for this review (pid $(cat "$pidfile"))."
    fi
    printf '%s\n' "$$" > "$pidfile"
    trap 'rm -f "$pidfile"' EXIT
    while [ -d "$scratch" ] && [ ! -e "$scratch/sync.request" ]; do sleep 1; done
    if [ ! -d "$scratch" ]; then echo GONE; exit 0; fi
    # The file's first word says what is asked; give the extension a moment to finish writing it.
    sleep 0.2
    what="$(head -c 5 "$scratch/sync.request" 2>/dev/null || true)"
    rm -f "$scratch/sync.request"
    if [ "$what" = draft ]; then echo DRAFT; else echo SYNC; fi
    ;;

  *) usage ;;
esac
