import { renderPage } from "./page";

export interface Env {
  KV: KVNamespace;
  DISCORD_WEBHOOK?: string;
  DISCORD_USER_ID?: string;
  TAGS: string;
  OWNER_NAME: string;
  HOURLY_CAP?: string;
}

const COOLDOWN_SECONDS = 60;
const HOURLY_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_HOURLY_CAP = 20;
const SANITIZE_PATTERN = /[`*_~|@[\]()<>]/g;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function serverError(): Response {
  return new Response("Server error", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseTags(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to empty map
  }
  return {};
}

function parseHourlyCap(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURLY_CAP;
}

export function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "Someone";
  const cleaned = name
    .replace(SANITIZE_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "Someone";
}

function hourBucket(now: Date): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const hh = now.getUTCHours().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}`;
}

async function handlePage(token: string, env: Env): Promise<Response> {
  const tags = parseTags(env.TAGS);
  if (!(token in tags)) return notFound();

  const html = renderPage(env.OWNER_NAME);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    },
  });
}

async function handleRing(token: string, request: Request, env: Env): Promise<Response> {
  const tags = parseTags(env.TAGS);
  const label = tags[token];
  if (label === undefined) return notFound();

  if (!env.DISCORD_WEBHOOK) {
    console.error("Missing required secret: DISCORD_WEBHOOK");
    return serverError();
  }
  if (!env.DISCORD_USER_ID) {
    console.error("Missing required secret: DISCORD_USER_ID");
    return serverError();
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (typeof body !== "object" || body === null) body = {};

  const name = sanitizeName((body as Record<string, unknown>).name);

  const cooldownKey = `cd:${token}`;
  const existingCooldown = await env.KV.get(cooldownKey);
  if (existingCooldown !== null) {
    return json({ ok: false, error: "cooldown" }, 429);
  }

  const cap = parseHourlyCap(env.HOURLY_CAP);
  const hourKey = `hr:${hourBucket(new Date())}`;
  const currentCountRaw = await env.KV.get(hourKey);
  const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) || 0 : 0;
  if (currentCount >= cap) {
    return json({ ok: false, error: "cap" }, 429);
  }

  await env.KV.put(cooldownKey, "1", { expirationTtl: COOLDOWN_SECONDS });
  await env.KV.put(hourKey, String(currentCount + 1), { expirationTtl: HOURLY_TTL_SECONDS });

  const payload = {
    username: "Doorbell",
    content: `<@${env.DISCORD_USER_ID}> \u{1F514} ${name} is at your door (${label})`,
    allowed_mentions: { users: [env.DISCORD_USER_ID] },
  };

  let discordResponse: Response;
  try {
    discordResponse = await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    await env.KV.delete(cooldownKey);
    console.error("Discord webhook request failed");
    return json({ ok: false, error: "upstream" }, 502);
  }

  if (!discordResponse.ok) {
    await env.KV.delete(cooldownKey);
    console.error(`Discord webhook returned status ${discordResponse.status}`);
    return json({ ok: false, error: "upstream" }, 502);
  }

  return json({ ok: true }, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pageMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    const ringMatch = url.pathname.match(/^\/r\/([^/]+)\/ring$/);

    if (pageMatch && request.method === "GET") {
      return handlePage(pageMatch[1], env);
    }
    if (ringMatch && request.method === "POST") {
      return handleRing(ringMatch[1], request, env);
    }
    return notFound();
  },
};
