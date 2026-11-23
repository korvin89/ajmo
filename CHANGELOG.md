# Changelog

What changed for somebody who uses Ajmo, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.24.6] — 2026-11-23

The first public release.

### Added

- The sessions panel: every Claude Code session grouped by repository, with
  its status, a counter of sessions that need you and a shortcut to the next
  one; starting a session, search and filters, deleting a session together
  with the files it left.
- Code windows: "Open Code in New Window", the Changes view with diffs
  against the base, comment threads on the lines, the Draft view with Sync
  and "Post the Draft to GitHub".
- The `ajmo` plugin for Claude Code with two skills: `/ajmo:code-review`
  (review a pull request with the agent on the lines) and `/ajmo:task` (take
  your own task to a merged PR).

[Unreleased]: https://github.com/korvin89/ajmo/compare/v0.24.6...HEAD
[0.24.6]: https://github.com/korvin89/ajmo/releases/tag/v0.24.6
