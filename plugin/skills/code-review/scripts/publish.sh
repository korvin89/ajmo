#!/usr/bin/env bash
#
# publish.sh — bring the reviewer's pending review on GitHub (the draft) in
# line with the review's threads. Nothing is ever submitted: the reviewer
# presses Submit on GitHub. A draft the reviewer already started is joined,
# not replaced — GitHub allows one pending review per user per PR.
#
# Usage:
#   publish.sh <scratch> [--allow-moved] [--dry-run [--files <ndjson>]]
#
# Run `threads.sh fold <scratch>` first, so the threads hold everything the
# reviewer wrote.
#
# What is published, per thread of threads.json:
#   - your findings (comments with "kind": "finding"), opened with the AI
#     marker;
#   - the reviewer's own comments ("to": "github"), word for word.
# Talk with the reviewer — their "to": "agent" comments and your replies — is
# never published. One thread becomes one thread on GitHub: its first
# publishable comment starts it, the next ones are replies in it. A thread
# that already lives on GitHub (its id starts with "gh:") gets them all as
# replies, in the same pending review.
#
# A second run publishes only the difference: new comments are added, edited
# ones are updated, deleted ones and dropped threads are removed from the
# draft. What was published is remembered in threads.json, per thread:
#   "github": { "thread": "<id>", "comments": { "<local id>": { "id": "<id>", "body": "<as published>" } } }
# and the thread's state becomes "published".
#
# Where a comment lands:
#   line      a line inside the PR's diff, on the side the thread is on
#   file      a file of the PR but a line outside its diff: a file-level
#             thread with `path:line` on top
#   skipped   a file outside the PR's diff: GitHub has no place for it; the
#             line is printed for the summary the reviewer writes at Submit
# A comment that is already submitted is never edited or deleted: it is
# reported as `kept`.
#
# Output: one line per action — added, added (file-level), replied, edited,
# deleted, skipped, kept, failed — and a last line that starts with "Draft:".
#
# --dry-run prints the plan as JSON and writes nothing. With --files <ndjson>
# (the PR's files as {filename, patch} lines) it does not call GitHub at all.
# --allow-moved publishes even when the PR head is not the commit the review
# was made on.
#
# Environment, set by the task skill, whose scratch serves several PRs:
#   AJMO_PR_URL   the PR to publish to, instead of <scratch>/pr.url
#   AJMO_ROOT     publish only the threads of this worktree (their "root")
#
# Exit codes: 0 ok · 1 a GitHub call failed (some actions may have gone in:
#             run again, it resumes) · 2 no threads.json or no pr.url in the
#             scratch · 3 gh or jq missing · 4 bad usage · 5 nothing to publish
#             · 8 the PR head moved since the review and nothing was written

set -euo pipefail

MARKER='🤖 **AI generated**'

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$*"; exit "$code"; }
usage() { die 4 "Usage: publish.sh <scratch> [--allow-moved] [--dry-run [--files <ndjson>]]"; }

command -v jq >/dev/null 2>&1 || die 3 "jq is required but was not found."

scratch=""; dry=0; files_arg=""; allow_moved=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     dry=1 ;;
    --allow-moved) allow_moved=1 ;;
    --files)       files_arg="${2:-}"; [ -n "$files_arg" ] || usage; shift ;;
    --*)           usage ;;
    *)             [ -z "$scratch" ] || usage; scratch="$1" ;;
  esac
  shift
done
[ -n "$scratch" ] || usage
[ -z "$files_arg" ] || [ "$dry" = 1 ] || die 4 "--files works only with --dry-run."
file="$scratch/threads.json"
[ -s "$file" ] || die 2 "No threads.json in $scratch: there is nothing to publish."
[ -n "${AJMO_PR_URL:-}" ] || [ -s "$scratch/pr.url" ] || die 2 "No pr.url in $scratch."

url="${AJMO_PR_URL:-$(cat "$scratch/pr.url")}"
rest="${url#*://}"; host="${rest%%/*}"; rest="${rest#*/}"
owner="${rest%%/*}"; rest="${rest#*/}"; repo="${rest%%/*}"; num="${url##*/}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# gql <query> <variables-json> — print the response; fail on any error.
gql() {
  jq -n --arg q "$1" --argjson v "$2" '{query: $q, variables: $v}' > "$tmp/req.json"
  if ! gh api graphql --hostname "$host" --method POST --input "$tmp/req.json" > "$tmp/resp.json" 2> "$tmp/gh.err"; then
    err "GitHub API error: $(tail -n 1 "$tmp/gh.err")"
    return 1
  fi
  if jq -e '.errors | length > 0' "$tmp/resp.json" >/dev/null 2>&1; then
    err "GitHub API error: $(jq -r '.errors[0].message' "$tmp/resp.json")"
    return 1
  fi
  cat "$tmp/resp.json"
}

# ------------------------------------------------------ the PR's files ------
if [ -n "$files_arg" ]; then
  cp "$files_arg" "$tmp/files.ndjson"
else
  command -v gh >/dev/null 2>&1 || die 3 "GitHub CLI (gh) is required but was not found. Install it: https://cli.github.com/"
  gh api --hostname "$host" "repos/$owner/$repo/pulls/$num/files?per_page=100" --paginate \
    --jq '.[] | {filename, patch}' > "$tmp/files.ndjson" 2> "$tmp/gh.err" \
    || die 1 "GitHub API error: $(tail -n 1 "$tmp/gh.err")"

  wt="$scratch/$(cat "$scratch/checkout" 2>/dev/null || echo head)"
  if [ "$allow_moved" = 0 ] && [ -e "$wt/.git" ]; then
    reviewed="$(git -C "$wt" rev-parse HEAD)"
    head="$(gh pr view "$url" --json headRefOid --jq .headRefOid 2> "$tmp/gh.err")" \
      || die 1 "GitHub API error: $(tail -n 1 "$tmp/gh.err")"
    [ "$head" = "$reviewed" ] \
      || die 8 "PR head moved: reviewed $reviewed, the head is now $head. Nothing was written."
  fi
fi

# ------------------------------------------------------------- the plan -----
# Every line inside a hunk accepts a comment: added and context lines on the
# new side (RIGHT), removed and context lines on the old side (LEFT).
plan="$(jq -c --arg marker "$MARKER" --arg root "${AJMO_ROOT:-}" --slurpfile files "$tmp/files.ndjson" '
  def lines:
    if .patch == null then {RIGHT: {}, LEFT: {}}
    else reduce (.patch | split("\n"))[] as $l ({new: 0, old: 0, RIGHT: {}, LEFT: {}};
           if ($l | startswith("@@")) then
             .old = ($l | capture("-(?<c>[0-9]+)").c | tonumber) | .new = ($l | capture("\\+(?<c>[0-9]+)").c | tonumber)
           elif ($l | startswith("\\")) then .
           elif ($l | startswith("+")) then .RIGHT[.new | tostring] = true | .new += 1
           elif ($l | startswith("-")) then .LEFT[.old | tostring] = true | .old += 1
           else .RIGHT[.new | tostring] = true | .LEFT[.old | tostring] = true | .new += 1 | .old += 1 end)
         | {RIGHT, LEFT}
    end;
  def rendered:
    if .author == "agent" then (if (.body | startswith($marker)) then .body else $marker + "\n\n" + .body end) else .body end;
  ($files | map({key: .filename, value: lines}) | from_entries) as $ok
  | [ .threads[] | select($root == "" or (.root // $root) == $root) | . as $t
      | "\($t.path):\($t.line)" as $where
      | ($t.github.comments // {}) as $known
      | [ $t.comments[] | select((.author == "agent" and .kind == "finding") or (.author == "user" and .to == "github"))
          | {cid: .id, body: rendered} ] as $pub
      | if $t.state == "dropped" then
          ($known | to_entries[] | {op: "delete", tid: $t.id, cid: .key, gh: .value.id, where: $where})
        elif ($t.github.thread // null) == null then
          ( ($pub[0] // empty) as $first
            | (if ($ok[$t.path] // null) == null then "skip"
               elif $ok[$t.path][$t.side // "RIGHT"][$t.line | tostring] then "line" else "file" end) as $to
            | {op: "thread", tid: $t.id, cid: $first.cid, to: $to, where: $where, path: $t.path, line: $t.line,
               side: ($t.side // "RIGHT"),
               body: (if $to == "file" then ($first.body | if startswith($marker) then $marker + "\n\n`\($where)`\n\n" + (.[($marker | length):] | sub("^\\s+"; "")) else "`\($where)`\n\n" + . end)
                      else $first.body end)} ),
          ( $pub[1:][] | {op: "reply", tid: $t.id, cid: .cid, body: .body, where: $where} )
        else
          ( $pub[] | . as $c
            | if ($known[$c.cid] // null) == null then {op: "reply", tid: $t.id, cid: $c.cid, body: $c.body, where: $where}
              elif $known[$c.cid].body != $c.body then {op: "edit", tid: $t.id, cid: $c.cid, gh: $known[$c.cid].id, body: $c.body, where: $where}
              else empty end ),
          ( $known | to_entries[] | select(.key as $k | ($pub | map(.cid) | index($k)) == null)
            | {op: "delete", tid: $t.id, cid: .key, gh: .value.id, where: $where} )
        end ]
' "$file")"

if [ "$dry" = 1 ]; then
  printf '%s\n' "$plan" | jq .
  exit 0
fi
[ "$(jq 'length' <<<"$plan")" -gt 0 ] || die 5 "Nothing to publish: the draft already matches the threads."

# ------------------------------------------------- the pending review -------
find='query($o: String!, $r: String!, $n: Int!) {
  viewer { login }
  repository(owner: $o, name: $r) { pullRequest(number: $n) { id
    reviews(states: PENDING, first: 10) { nodes { id author { login } comments(first: 100) { nodes { id } } } } } } }'
raw="$(gql "$find" "$(jq -n --arg o "$owner" --arg r "$repo" --argjson n "$num" '{o: $o, r: $r, n: $n}')")" || exit 1
mine='.data.viewer.login as $me | first((.data.repository.pullRequest.reviews.nodes // [])[] | select(.author.login == $me))'
review="$(jq -r "$mine | .id // empty" <<<"$raw")"
# Comments still in the draft: only these may be edited or deleted.
pending_ids="$(jq -c "[ ($mine | .comments.nodes[]?.id) ]" <<<"$raw")"
how="joined the existing draft"

open_review() {
  [ -n "$review" ] && return 0
  review="$(gql 'mutation($pr: ID!) { addPullRequestReview(input: {pullRequestId: $pr}) { pullRequestReview { id } } }' \
    "$(jq -c '{pr: .data.repository.pullRequest.id}' <<<"$raw")" | jq -r '.data.addPullRequestReview.pullRequestReview.id')" || return 1
  how="started a new draft"
}

# save — atomic: the extension may read the file at any moment.
save() { local t="$file.$$.tmp"; cat > "$t"; mv "$t" "$file"; }
is_pending() { jq -e --arg id "$1" 'index($id) != null' <<<"$pending_ids" >/dev/null; }

added=0; files=0; replied=0; edited=0; deleted=0; skipped=0; kept=0; failed=0
while IFS= read -r item; do
  op="$(jq -r .op <<<"$item")"; tid="$(jq -r .tid <<<"$item")"; cid="$(jq -r .cid <<<"$item")"
  where="$(jq -r .where <<<"$item")"; body="$(jq -r '.body // ""' <<<"$item")"
  case "$op" in
    thread)
      to="$(jq -r .to <<<"$item")"
      if [ "$to" = skip ]; then
        printf 'skipped  %s — file is not in the PR diff\n' "$where"; skipped=$((skipped + 1)); continue
      fi
      open_review || { printf 'failed   %s\n' "$where"; failed=$((failed + 1)); continue; }
      if [ "$to" = line ]; then
        out="$(gql 'mutation($r: ID!, $p: String!, $l: Int!, $s: DiffSide!, $b: String!) {
            addPullRequestReviewThread(input: {pullRequestReviewId: $r, path: $p, line: $l, side: $s, subjectType: LINE, body: $b}) {
              thread { id comments(first: 1) { nodes { id } } } } }' \
          "$(jq -c --arg r "$review" '{r: $r, p: .path, l: .line, s: .side, b: .body}' <<<"$item")")" || out=""
      else
        out="$(gql 'mutation($r: ID!, $p: String!, $b: String!) {
            addPullRequestReviewThread(input: {pullRequestReviewId: $r, path: $p, subjectType: FILE, body: $b}) {
              thread { id comments(first: 1) { nodes { id } } } } }' \
          "$(jq -c --arg r "$review" '{r: $r, p: .path, b: .body}' <<<"$item")")" || out=""
      fi
      gh_thread="$(jq -r '.data.addPullRequestReviewThread.thread.id // empty' <<<"${out:-{\}}" 2>/dev/null || true)"
      gh_comment="$(jq -r '.data.addPullRequestReviewThread.thread.comments.nodes[0].id // empty' <<<"${out:-{\}}" 2>/dev/null || true)"
      if [ -z "$gh_thread" ]; then printf 'failed   %s\n' "$where"; failed=$((failed + 1)); continue; fi
      jq --arg t "$tid" --arg c "$cid" --arg gt "$gh_thread" --arg gc "$gh_comment" --arg b "$body" '
        .threads |= map(if .id == $t then .state = "published" | .github = {thread: $gt, comments: {($c): {id: $gc, body: $b}}} else . end)' "$file" | save
      added=$((added + 1))
      if [ "$to" = file ]; then files=$((files + 1)); printf 'added    %s (file-level)\n' "$where"; else printf 'added    %s\n' "$where"; fi
      ;;

    reply)
      gh_thread="$(jq -r --arg t "$tid" '.threads[] | select(.id == $t) | .github.thread // empty' "$file")"
      # The thread itself was skipped or failed above: nothing to reply into.
      [ -n "$gh_thread" ] || continue
      open_review || { printf 'failed   %s\n' "$where"; failed=$((failed + 1)); continue; }
      gh_comment="$(gql 'mutation($r: ID!, $t: ID!, $b: String!) {
          addPullRequestReviewThreadReply(input: {pullRequestReviewId: $r, pullRequestReviewThreadId: $t, body: $b}) { comment { id } } }' \
        "$(jq -n --arg r "$review" --arg t "$gh_thread" --arg b "$body" '{r: $r, t: $t, b: $b}')" \
        | jq -r '.data.addPullRequestReviewThreadReply.comment.id // empty')" || gh_comment=""
      if [ -z "$gh_comment" ]; then printf 'failed   %s\n' "$where"; failed=$((failed + 1)); continue; fi
      jq --arg t "$tid" --arg c "$cid" --arg gc "$gh_comment" --arg b "$body" '
        .threads |= map(if .id == $t then .state = "published" | .github.comments[$c] = {id: $gc, body: $b} else . end)' "$file" | save
      replied=$((replied + 1)); printf 'replied  %s\n' "$where"
      ;;

    edit)
      gh="$(jq -r .gh <<<"$item")"
      if ! is_pending "$gh"; then printf 'kept     %s — already submitted\n' "$where"; kept=$((kept + 1)); continue; fi
      if gql 'mutation($id: ID!, $b: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $b}) { pullRequestReviewComment { id } } }' \
          "$(jq -n --arg id "$gh" --arg b "$body" '{id: $id, b: $b}')" >/dev/null; then
        jq --arg t "$tid" --arg c "$cid" --arg b "$body" '.threads |= map(if .id == $t then .github.comments[$c].body = $b else . end)' "$file" | save
        edited=$((edited + 1)); printf 'edited   %s\n' "$where"
      else
        printf 'failed   %s\n' "$where"; failed=$((failed + 1))
      fi
      ;;

    delete)
      gh="$(jq -r .gh <<<"$item")"
      if is_pending "$gh"; then
        if ! gql 'mutation($id: ID!) { deletePullRequestReviewComment(input: {id: $id}) { clientMutationId } }' \
            "$(jq -n --arg id "$gh" '{id: $id}')" >/dev/null; then
          printf 'failed   %s\n' "$where"; failed=$((failed + 1)); continue
        fi
        deleted=$((deleted + 1)); printf 'deleted  %s\n' "$where"
      else
        printf 'kept     %s — already submitted\n' "$where"; kept=$((kept + 1))
      fi
      # Forget it either way; a thread with nothing left on GitHub is local again.
      jq --arg t "$tid" --arg c "$cid" '
        .threads |= map(if .id == $t then
          del(.github.comments[$c])
          | if (.github.comments | length) == 0 then
              # A thread that lives on GitHub ("gh:…") stays tied to it.
              (if (.id | startswith("gh:")) then . else del(.github) end) | (if .state == "published" then .state = "open" else . end)
            else . end
        else . end)' "$file" | save
      ;;
  esac
done < <(jq -c '.[]' <<<"$plan")

printf 'Draft: %s/files — %s; added %s (%s file-level), replied %s, edited %s, deleted %s, skipped %s, kept %s, failed %s. Nothing was submitted.\n' \
  "$url" "$how" "$added" "$files" "$replied" "$edited" "$deleted" "$skipped" "$kept" "$failed"
[ "$failed" = 0 ] || exit 1
