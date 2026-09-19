# DeepSeek Balance Ring Extension

Displays your DeepSeek account balance inside SuperIsland with a circular indicator.

This extension is presentation only: it reads the native usage provider
(`SuperIsland.system.getAIUsage().deepseek`) and performs no network requests of
its own, so it does not request the `network` permission and never touches your
API key.

## Colors

- Green: balance is healthy relative to the configured reference value
- Orange: at or below 25% of the reference value
- Red: at or below 10% of the reference value, or `is_available == false`

## Permissions

- `usage` (required for `SuperIsland.system.getAIUsage()`)

## Displayed Value

DeepSeek only exposes a balance endpoint (an amount), not a quota percentage, so
the number next to the ring is always the real balance (`¥86.79`). The ring
progress is `balance / deepseekBudget` — a purely visual mapping so the ring
still conveys health at a glance.

## Credentials

All API keys live in one local file:

```
~/Library/Application Support/SuperIsland/ai-credentials.json
```

Use the **打开凭据配置文件夹** button in the extension settings to reveal it in
Finder. The file is created with `0600` permissions and is read by the native
provider, never by extension JavaScript.

```json
{
  "version": 1,
  "providers": {
    "deepseek": {
      "active": "personal",
      "keys": [
        { "id": "personal", "label": "个人账号", "api_key": "sk-..." },
        { "id": "work", "label": "公司账号", "api_key": "sk-..." }
      ]
    }
  }
}
```

One provider can hold several keys; `active` picks which one is used. It matches
either the `id` or the `label`; if `active` is missing or matches nothing, the
first non-empty key wins.

Shorthands accepted for single-key providers:

- `"deepseek": "sk-..."` (bare string)
- `"deepseek": { "keys": { "default": "sk-..." } }` (dictionary)

Resolution order per provider — the first hit wins, and the source is shown in
the island's expanded view (`Key 来源 …`) so the active key is never ambiguous:

1. `ai-credentials.json`
2. `DEEPSEEK_API_KEY` environment variable
3. macOS keychain, generic password with service `DeepSeek API Key` (or `deepseek`)

The keychain is read **silently only** — SuperIsland never shows a keychain
authorization prompt, because a prompt would block the usage refresh. Create the
item with `-A` so the app may read it without warning:

```sh
security add-generic-password -A -s "DeepSeek API Key" -a "$USER" -w "sk-..."
```

An item created without `-A` is not readable silently and is therefore ignored;
use the config file in that case.

## Data Source

- `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <key>`,
  executed by the native provider (refreshed with the shared 5-minute cache).
- Response fields used: `is_available`, `balance_infos[].currency` (CNY preferred),
  `total_balance`, `granted_balance`, `topped_up_balance`.

## Settings

- `showDeepSeek` — hide the module entirely (default on)
- `deepseekBudget` — reference value (CNY) that maps the balance onto the ring;
  click +/- or type a number directly
- **打开凭据配置文件夹** — reveal the credentials file in Finder
