# Cloudflare DNS page (fork feature, branch `dns`)

This branch adds one page to caddy-ui: every DNS record of every zone of one
or more Cloudflare accounts in one table. From there you can add, edit,
delete, bulk-repoint and export records.

It is for the **laptop only**. The production dashboard builds upstream's
unmodified commit and never contains this code.

## Why it exists

DNS for years of subdomains was edited by hand, one record at a time, in the
Cloudflare dashboard.

## Rules it keeps

- **Cloudflare is the source of truth.**
  - The table is a fresh read every time.
  - Nothing is cached.
  - Dashboard edits keep working.
- **Every write is staged, previewed, then applied.**
  - Preview re-reads each record from Cloudflare.
  - If a record changed there since you staged it, the change is **refused**,
    not overwritten.
- **Every apply saves the before-state first** — a JSON snapshot in
  `~/.local/share/caddy-ui-dns/`.
  - *Stage revert* turns a snapshot into a change list.
  - That list goes through the same preview → apply.
- **Tokens are read from one file and nowhere else.**
  - They are never shown, never accepted through the UI, never logged.
  - They are never returned by the API.
- **Pacing.** It stays under Cloudflare's limit of 1200 requests per 5 minutes,
  and waits out a 429.
- **Applies run record by record, each with its own result.** One failure does
  not stop the rest.

## Setup

```bash
mkdir -p -m 700 ~/.caddy-ui-dns ~/.local/share/caddy-ui-dns
cat > ~/.caddy-ui-dns/accounts.json <<'EOF'
[
  { "name": "main", "token": "..." },
  { "name": "msca", "token": "..." }
]
EOF
chmod 600 ~/.caddy-ui-dns/accounts.json
docker compose -f dns-laptop/compose.yml up -d --build
open http://127.0.0.1:9878/dns
```

- **Location.** `~/.caddy-ui-dns` is deliberately outside `~/.config`, so
  dotfile sync never carries the tokens.
- **Zero accounts.** That is a valid state: the page says how to add one.
- **Editing the file.** Run `docker compose -f dns-laptop/compose.yml restart backend`
  afterwards.

## Tokens: one per Cloudflare account

Create each one at *My Profile → API Tokens → Create custom token*:

| setting | value |
|---|---|
| Permissions | `Zone → Zone → Read`, `Zone → DNS → Edit` |
| Zone resources | **Specific zones** — the ones you manage here |
| TTL | an end date (e.g. 6–12 months) |
| Name | `caddy-ui-dns-laptop-<account>` |

- Never reuse the production box's ACME tokens. Revoking one for an incident
  would otherwise break certificate renewal.
- To rotate: edit `accounts.json`, then restart the backend.
- To revoke: delete the token in the Cloudflare dashboard. That takes effect
  immediately.
- Cloudflare's audit log records each change under the token's name.

## Exports are confidential

JSON, CSV and BIND exports, and the snapshots, reveal **origin IPs** that
Cloudflare's proxy otherwise hides. They also hold verification TXT values
and every forgotten staging host.

- Downloads land in your browser's download folder.
- Snapshots land in `~/.local/share/caddy-ui-dns/`.
- Never commit them. This fork is public; `.gitignore` blocks the usual names.

## What is editable

| | |
|---|---|
| Create / edit | A, AAAA, CNAME, TXT, MX |
| Delete, view, export | any record type |
| Proxied | A, AAAA, CNAME only |

## Code

| | |
|---|---|
| `src/backend/src/dns/` | accounts, Cloudflare client, service (preview / apply / snapshots / export) |
| `src/backend/src/routes/dns.js` | `/api/dns/*` |
| `src/frontend/src/components/Dns.jsx` | the page |
| `src/backend/test/dns.test.js` | unit tests |
| `dns-laptop/compose.yml` | the laptop instance |

Upstream files touched, ≈10 lines, to keep rebases cheap:

- `src/backend/src/index.js` — route registration
- `src/frontend/src/App.jsx` — import, title, route, zero-instance allowlist
- `src/frontend/src/components/Sidebar.jsx` — nav entry
- `src/frontend/src/i18n/locales/en.js` — two keys

Page text is English-only inside `Dns.jsx` for the same reason.

End-to-end tests against a mock Cloudflare live in the deployment repo
(`proxy-sandboxes/tests/dns-ui.sh`).
