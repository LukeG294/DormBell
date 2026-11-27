# DormBell

A tap-to-notify doorbell: a visitor taps an NFC tag (or scans a QR code), types an optional name, and you get a Discord ping saying who is at the door. No app for the visitor, no accounts, no admin dashboard — see [SPEC.md](SPEC.md) for the full brief.

Open source under the [MIT license](LICENSE) — fork it, point it at your own Cloudflare account and Discord server, and it's yours.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free tier is enough).
- [Node.js](https://nodejs.org/) 18 or later, and npm.
- The [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) CLI — installed automatically as a dev dependency below, or install globally with `npm install -g wrangler`.

Install project dependencies:

```bash
npm install
```

## 1. Create the Discord webhook and find your user ID

1. In the Discord server you want pings in, open **Server Settings → Integrations → Webhooks → New Webhook**. Pick the channel, copy the **Webhook URL** — this is your `DISCORD_WEBHOOK` secret.
2. Turn on Developer Mode: **User Settings → Advanced → Developer Mode**.
3. Right-click your own name/avatar anywhere in Discord and choose **Copy User ID**. This is your `DISCORD_USER_ID` secret.

Neither value ever goes into a file that's committed to the repo — only into `wrangler secret put` and your local, git-ignored `.dev.vars`.

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create dorm-doorbell-kv
```

Wrangler prints an `id`. Put it into [`wrangler.toml`](wrangler.toml), replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
kv_namespaces = [
  { binding = "KV", id = "<the id wrangler printed>" }
]
```

## 3. Generate a tag token and add it to TAGS

```bash
openssl rand -hex 8
```

This prints a random 16-character hex token (use `-hex 12` or more for a longer one). Add it to the `TAGS` var in `wrangler.toml`, mapping the token to a short label:

```toml
TAGS = "{\"<your-generated-token>\":\"Door\"}"
```

Add one entry per physical tag. Also set `OWNER_NAME` (the first name shown on the page) and, optionally, `HOURLY_CAP` (default `20`).

## 4. Set secrets and deploy

For local development, copy the example file and fill in real values — `.dev.vars` is git-ignored and never committed:

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run dev
```

For production, set the secrets on Cloudflare (you'll be prompted to paste each value):

```bash
npx wrangler secret put DISCORD_WEBHOOK
npx wrangler secret put DISCORD_USER_ID
```

Then deploy:

```bash
npm run deploy
```

Wrangler prints your `*.workers.dev` URL (or your custom domain, if configured). The visitor link for a tag is:

```
https://<your-worker-domain>/r/<token>
```

## 5. Write the tag

1. Install an NFC writer app, such as [NFC Tools](https://www.wakdev.com/en/apps/nfc-tools.html), on your phone.
2. Write one **NDEF URL record** containing `https://<your-worker-domain>/r/<token>` to a blank **NTAG213** tag.
3. Optionally lock the tag read-only in the app once you've confirmed it works, so it can't be overwritten.
4. Print the same URL as a QR code and stick it next to the tag, for phones with NFC turned off.

## 6. Rotating a token or the webhook

**Rotate a tag's token** (e.g. if a link leaked or a tag was lost): remove the old token from `TAGS` in `wrangler.toml`, generate a new one (`openssl rand -hex 8`), add it under the same or a new label, run `npm run deploy`, and write a new physical tag with the new URL. The old URL will immediately start returning the generic 404.

**Rotate the webhook** (e.g. if the webhook URL was ever pasted somewhere public): delete the webhook in Discord's **Integrations** settings, create a new one, then run `npx wrangler secret put DISCORD_WEBHOOK` again with the new URL. No deploy or token change is needed.

## Development and testing

```bash
npm test
```

Tests mock the Discord `fetch` call and use an in-memory KV store, so running them never sends a real Discord message.

## Assumptions made while building

- `TAGS` is stored as a single JSON-encoded string var (e.g. `TAGS = "{\"token\":\"Door\"}"`) rather than a native TOML table, so the same `JSON.parse` code path works whether the var comes from `wrangler.toml` or is overridden at deploy time.
- `HOURLY_CAP` is a string var (as Cloudflare vars are) and is parsed as an integer at request time, falling back to the spec's default of `20` if unset or invalid.
- The hourly counter bucket (`hr:<YYYYMMDDHH>`) is keyed in UTC.
- The hourly counter increment is a plain KV read-then-write (not atomic). Workers KV doesn't offer atomic counters, and a doorbell's traffic is low and casual enough that a rare race under-counting by one ring is an acceptable trade-off for staying dependency-free.
- The Content-Security-Policy omits `style-src`/`script-src` hashes and uses `'unsafe-inline'` instead, since the page's inline `<style>` and `<script>` are static and authored by the Worker itself, not visitor input.
- A missing `DISCORD_WEBHOOK` or `DISCORD_USER_ID` secret at runtime returns a generic 500 and logs only the variable's name, never attempting to send a malformed ping.

## License

[MIT](LICENSE) — do whatever you want with it, no warranty.
