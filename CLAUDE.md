# Notes for Claude Code

## Commits and pull requests

- Never add AI attribution: no `Co-Authored-By: Claude …`, `Claude-Session: …` or
  "Generated with Claude Code" lines in commit messages, pull requests or comments.
- Commit as the person you're working for, never as `Claude <noreply@anthropic.com>`.
  Check `git var GIT_AUTHOR_IDENT` before the first commit of a session. If it shows Claude,
  set `git config user.name` and `git config user.email` to that person's GitHub identity
  (their `ID+login@users.noreply.github.com` address, so no personal email goes public),
  or ask them which to use.
