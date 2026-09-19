# AI Usage Rings Extension

Displays Codex + Claude usage and (optionally) DeepSeek balance inside
SuperIsland with circular indicators.

## Colors

- Green: healthy/available
- Orange: low
- Red: very low / blocked

## Permissions

- `usage` (required for `SuperIsland.system.getAIUsage()`)
- `network` (required for the DeepSeek balance request)

## Data Sources

- Codex:
  - `~/.codex/usage-summary.json` or `~/.codex/usage/summary.json`
  - fallback: ChatGPT OAuth usage API (`https://chatgpt.com/backend-api/wham/usage`) using token from `~/.codex/auth.json`
- Claude:
  - `~/.claude/usage-summary.json` or `~/.config/claude/usage-summary.json`
  - fallback: Anthropic OAuth usage API (`https://api.anthropic.com/api/oauth/usage`) using token from:
    - `~/.claude/.credentials.json` / `~/.claude/credentials.json`
    - macOS keychain service `Claude Code-credentials`
  - last fallback: `~/.claude/stats-cache.json`
- SuperIsland first checks the Claude keychain item without showing UI. If macOS
  requires a password prompt, SuperIsland only asks once and then falls back to
  local Claude usage/cache data unless the keychain item can be read silently.
- DeepSeek (optional):
  - `GET https://api.deepseek.com/user/balance` using the API key from the
    extension settings (`deepseekApiKey`). SuperIsland apps never call this
    endpoint; the extension does, via `SuperIsland.http.fetch`.
  - DeepSeek has no usage/quota API, so there is no “weekly / session” figure.
    The ring progress is `balance / deepseekBudget` (the user-configured
    top-up reference value) and only drives the fill and color; the label next
    to the ring always shows the real amount. `is_available == false` forces a
    red ring.
  - The API key is stored in UserDefaults as plain text. It is sent only to
    `api.deepseek.com`.

## Refresh Behavior

- The native usage provider cache refreshes every 5 minutes.
- Codex still updates from local summary / OAuth API data.
- Claude reads session (`five_hour`) and weekly (`seven_day*`) windows from OAuth usage when available.
- Week/session values no longer mirror overall remaining when source data is missing (they show `--%`).
- DeepSeek balance is refreshed every 5 minutes, on module activation, and
  whenever a relevant setting changes. Failed requests back off for 60 seconds.
