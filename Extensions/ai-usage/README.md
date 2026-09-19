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

## Credential Resolution

The native provider looks for the API key in this order and uses the first hit:

1. `DEEPSEEK_API_KEY` environment variable
2. `~/.deepseek/api_key` (also `~/.deepseek/key`, `~/.config/deepseek/api_key`) —
   plain key text or `{"api_key": "sk-..."}`
3. macOS keychain, generic password with service `DeepSeek API Key` (or `deepseek`)
4. Extension setting `deepseekApiKey` (plain text in UserDefaults) — fallback only

Options 1–3 avoid storing the key in plain text. Store it in the keychain with:

```sh
security add-generic-password -s "DeepSeek API Key" -a "$USER" -w "sk-..."
```

SuperIsland reads the keychain item silently first. If macOS requires
authorization it asks at most once, and if the item does not exist it never
prompts.

## Data Source

- `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <key>`,
  executed by the native provider (refreshed with the shared 5-minute usage cache,
  alongside Codex and Claude).
- Response fields used: `is_available`, `balance_infos[].currency` (CNY preferred),
  `total_balance`, `granted_balance`, `topped_up_balance`.

## Settings

- `showDeepSeek` — hide the module entirely (default on)
- `deepseekBudget` — reference value (CNY) that maps the balance onto the ring
- `deepseekApiKey` — fallback credential source, see above
