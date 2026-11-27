# Dorm Doorbell: NFC Tap-to-Notify Spec

Nov 26, 2026

## Overview

Build a tap-to-notify doorbell: a visitor taps an NFC tag (or scans a QR code), types an optional name, and the resident gets a Discord ping that says who is at the door.

The visitor needs no app. The tag stores a URL, and the URL opens a small web page served by a Cloudflare Worker. The Worker posts to a Discord webhook that pings the resident. Treat this document as the full brief: build exactly what it says, and list anything you had to assume in the README.

## Goals and non-goals

Version 1 does one thing well: a reliable, spam-resistant ping to one resident.

**Goals**

- A visitor goes from tap to "resident notified" in under 5 seconds on a normal phone connection.
- Works on iPhone and Android with no app installed.
- The resident's phone buzzes with an @mention, so it cuts through normal notification settings.
- Safe to leave on a door: rate-limited, no personal details exposed, no secrets in the page or the repo.
- Deploys with a single `wrangler deploy`.

**Non-goals for v1**

- Two-way replies or reply buttons (plain Discord webhooks cannot do these).
- Accounts, logins, or an admin dashboard.
- Multiple residents or a lobby directory.
- Storing visitor history beyond the short cooldown keys.

## User flows

There are three flows: the happy path, the repeat ring, and the bad link.

**Happy path**

1. The visitor taps the NFC tag, or scans the QR code printed beside it. The phone opens `https://<worker-domain>/r/<token>`.
2. The page shows a large button, "Let \<OwnerName> know you're here", and an optional name field.
3. The visitor presses the button. The page sends `POST /r/<token>/ring` with the name.
4. The Worker validates the token and checks the cooldown, then posts to Discord.
5. The page shows "\<OwnerName> has been notified. Hang tight!"
6. The resident's phone buzzes with: `@resident 🔔 **Maya** is at your door (Door)`.

**Repeat ring**

If the same tag was used in the last 60 seconds, the Worker returns HTTP 429 and sends nothing to Discord. The page shows "Already rang, hang tight!" and disables the button for 60 seconds.

**Bad or unknown link**

An unknown token returns a plain 404 page that says nothing about what the site is. It must look the same for every bad path.

## Architecture and stack

&#91;embedded content: doorbell architecture · 6 parts\]

The tag only stores a URL. The Worker does everything else: it serves the page, checks KV for the cooldown, then posts to the Discord webhook.

**Stack**

- Cloudflare Workers, written in TypeScript, with no framework and no runtime dependencies.
- Workers KV for the cooldown and hourly counter keys only.
- Wrangler for local dev and deploys.
- Vitest for tests, with the Discord call mocked.
- NFC tag: NTAG213 holding one NDEF URL record.

## Endpoints and behavior

The Worker exposes two routes. Every other path or method returns the same generic 404.

| Route | Purpose | Success | Failures |
| --- | --- | --- | --- |
| `GET /r/:token` | Serve the visitor page | 200 HTML | 404 if the token is not in `TAGS` |
| `POST /r/:token/ring` | Send the Discord ping | 200 JSON `{"ok":true}` | 404 bad token, 400 bad body, 429 cooldown or hourly cap, 502 Discord failure |

**Ring handler, in order**

1. Look up `:token` in the parsed `TAGS` map. Not found: 404.
2. Parse the JSON body. A missing or invalid body is treated as `{}`. Read `name` only if it is a string.
3. Sanitize the name: remove the characters ` * _  ` \~ | > @ \[ \] ( ) < >\`, collapse whitespace, trim, cut to 40 characters. If the result is empty, use "Someone".
4. Check the cooldown key `cd:<token>` in KV. If present: 429 with `{"ok":false,"error":"cooldown"}`.
5. Check the hourly counter `hr:<YYYYMMDDHH>` in KV. If it is at `HOURLY_CAP` (default 20): 429 with `{"ok":false,"error":"cap"}`.
6. Write the cooldown key with a 60-second TTL (the KV minimum), and increment the hourly counter with a 2-hour TTL.
7. POST to the Discord webhook (payload below). If Discord returns a non-2xx status, delete the cooldown key so the visitor can retry, log the status code only, and return 502 `{"ok":false,"error":"upstream"}`.
8. Return 200 `{"ok":true}`.

**Discord payload**

```json
{
  "username": "Doorbell",
  "content": "<@DISCORD_USER_ID> 🔔 **Maya** is at your door (Door)",
  "allowed_mentions": { "users": ["DISCORD_USER_ID"] }
}
```

The label in parentheses is the tag's label from `TAGS`. `allowed_mentions` must always list only the resident, so a visitor can never trigger `@everyone` or ping anyone else, even if sanitizing misses something.

## Visitor page

The visitor page is one self-contained HTML string returned by the Worker, with inline CSS and JavaScript and no third-party requests.

- **Layout:** mobile first, one centered column, the button at least 56 px tall. Light and dark themes through `prefers-color-scheme`.
- **Content:** a heading with the owner's first name (`OWNER_NAME`), an optional name field (max 40 characters, `autocomplete="name"`), and the ring button. No room number, no last name, no building name.
- **States:** idle, sending (button disabled, label "Ringing..."), success ("\<OwnerName> has been notified. Hang tight!"), cooldown ("Already rang, hang tight!", button disabled for 60 seconds), cap or upstream error ("Couldn't reach \<OwnerName> right now. Try texting instead."), and network error (same message as upstream).
- **Behavior:** the page calls `fetch(location.pathname + '/ring', { method: 'POST' })` with a JSON body. Prevent double submits while a request is in flight.
- **Headers:** `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and a `<meta name="robots" content="noindex">` tag. Add a strict `Content-Security-Policy` that allows only inline script and style for this page and `connect-src 'self'`.
- **Accessibility:** a visible label on the name field, status messages in an `aria-live="polite"` region, and a 4.5:1 minimum text contrast.

## Config and secrets

The webhook URL and the resident's Discord user ID are secrets. They live only in Worker secrets and in a git-ignored `.dev.vars` file, never in the code, the page, the README, or a commit.

| Name | Kind | Example | Notes |
| --- | --- | --- | --- |
| `DISCORD_WEBHOOK` | secret | `https://discord.com/api/webhooks/<id>/<token>` | Set with `wrangler secret put`. The real value is never written into any file in the repo. |
| `DISCORD_USER_ID` | secret | a long number | The resident's Discord user ID, used for the @mention. |
| `TAGS` | var (JSON) | `{"k8x2q9f4a1b7c3d0":"Door"}` | Maps each tag token to a label. Tokens are random, at least 16 hex characters. |
| `OWNER_NAME` | var | `Luke` | First name shown on the visitor page. |
| `HOURLY_CAP` | var | `20` | Maximum rings per hour across all tags. |
| `KV` | KV namespace binding |  | Holds cooldown and counter keys only. |

Commit a `.dev.vars.example` with placeholder values, and add `.dev.vars` to `.gitignore`. If a required secret is missing at runtime, return 500 with a generic message and log which variable is missing, never its value.

## Security, privacy and abuse protection

Anyone who finds a tag URL can hit it, so the design assumes hostile visitors and limits the damage.

- **Spam:** a 60-second cooldown per tag plus a global hourly cap. The cap stops a script from burying the resident in pings even if it rotates through valid tokens.
- **Mention injection:** names are sanitized and `allowed_mentions` is pinned to the resident, so no visitor input can ping `@everyone`, a role, or another user.
- **Unguessable links:** tokens are random and at least 16 hex characters. Never use a room number or a name in a URL.
- **Privacy:** the page and the Discord message never reveal a room number, last name, or building. A bad token and a bad route return the identical 404.
- **Secrets:** the webhook URL never appears in a response, a log line, an error message, or the repo. Logs record status codes and event names only.
- **Tag cloning:** NFC tags are trivially copyable, and that is acceptable for a doorbell. A tap proves nothing about identity. If a link is abused, remove its token from `TAGS` and redeploy, then write a new tag.
- **Webhook rotation:** if the webhook URL is ever shared or pasted anywhere public, delete it in Discord and create a new one, then run `wrangler secret put DISCORD_WEBHOOK` again.

## Project structure and deliverables

The deliverable is a small TypeScript Worker project that deploys with `wrangler deploy` and ships with tests and a README.

```text
dorm-doorbell/
  src/
    index.ts        router, ring handler, sanitizer, Discord call
    page.ts         exports the visitor page HTML as a function of OWNER_NAME
  test/
    index.test.ts   unit and handler tests (Discord fetch mocked)
  wrangler.toml     name, main, compatibility_date, KV binding, vars
  package.json      scripts: dev, deploy, test
  tsconfig.json
  .dev.vars.example placeholder secrets only
  .gitignore        includes .dev.vars and node_modules
  README.md
```

**The README must cover**

1. Prerequisites: a Cloudflare account, Node, and `wrangler`.
2. Creating the Discord webhook and finding the user ID (Developer Mode, then Copy User ID).
3. Creating the KV namespace and putting its ID in `wrangler.toml`.
4. Generating a token with `openssl rand -hex 8` or longer, and adding it to `TAGS`.
5. Setting secrets with `wrangler secret put`, then deploying.
6. Writing the tag: use an NFC writer app (such as NFC Tools) to write one NDEF URL record, `https://<worker-domain>/r/<token>`, to an NTAG213 tag. Optionally lock it read-only. Print the same URL as a QR code for phones with NFC off.
7. Rotating a token and rotating the webhook.
8. Any assumptions made while building.

## Acceptance criteria and test plan

v1 is done when every item below passes. Automated tests mock the Discord `fetch` and use an in-memory KV, so they never send a real message.

**Automated tests**

- [ ] `GET /r/<valid token>` returns 200 HTML containing the owner's name and no secrets.
- [ ] `GET /r/<bad token>` and every other route return an identical generic 404.
- [ ] A valid ring calls Discord once with `allowed_mentions.users` equal to exactly the resident's ID.
- [ ] A name like `@everyone **hi** <@123>` is sanitized so it contains no `@`, `*`, `<` or `>`.
- [ ] A name over 40 characters is cut to 40; an empty or non-string name becomes "Someone".
- [ ] A second ring within 60 seconds returns 429 and does not call Discord.
- [ ] The hourly cap returns 429 once `HOURLY_CAP` is reached, and the counter resets in the next hour.
- [ ] A Discord failure returns 502, clears the cooldown key, and the response and logs contain no part of the webhook URL.
- [ ] A malformed JSON body is handled without a 500.

**Manual checks on a real device**

- [ ] With `wrangler dev` and a test webhook, tapping the tag on an iPhone and on an Android phone opens the page and a ring buzzes the resident's phone with an @mention.
- [ ] The page renders correctly in light and dark mode at 360 px width.
- [ ] The deployed Worker works over HTTPS and the tag URL matches a token in `TAGS`.
- [ ] A search of the repo and git history finds no webhook URL or user ID.

## Future work and open questions

Nothing here is in scope for v1. Do not build it unless asked.

**Possible later versions**

- Two-way replies ("Coming", "Give me 5") by replacing the webhook with a Discord bot or a Telegram bot with inline buttons.
- Visit types, such as friend, delivery, or other, chosen on the page and shown in the ping.
- Per-tag labels for personal friend tags, so the ping says who rang the keychain.
- Several residents or roommates, notified together.
- A lobby directory page for a shared tag at the building entrance (needs hall staff approval).

**Open questions for the resident**

- Which domain or `workers.dev` subdomain should the Worker use?
- Should the cooldown be per tag (current plan) or per visitor IP as well?
- Does housing policy allow a permanent tag on the door? Check with the RA before sticking it on.
