import { renderPage } from "../src/page";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, sanitizeName } from "../src/index";

const TOKEN = "k8x2q9f4a1b7c3d0";
const LABEL = "Door";
const OWNER_NAME = "Luke";
const RESIDENT_ID = "999999999999999999";
const WEBHOOK_URL = "https://discord.com/api/webhooks/123/secret-token";

class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV: new MemoryKV() as unknown as Env["KV"],
    DISCORD_WEBHOOK: WEBHOOK_URL,
    DISCORD_USER_ID: RESIDENT_ID,
    TAGS: JSON.stringify({ [TOKEN]: LABEL }),
    OWNER_NAME,
    HOURLY_CAP: "20",
    ...overrides,
  };
}

function ringRequest(token: string, body?: unknown): Request {
  return new Request(`https://example.com/r/${token}/ring`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function pageRequest(path: string, method = "GET"): Request {
  return new Request(`https://example.com${path}`, { method });
}

describe("GET /r/:token", () => {
  it("returns 200 HTML with the owner's name and no secrets", async () => {
    const env = makeEnv();
    const res = await worker.fetch(pageRequest(`/r/${TOKEN}`), env);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(text).toContain(OWNER_NAME);
    expect(text).not.toContain(WEBHOOK_URL);
    expect(text).not.toContain(RESIDENT_ID);
  });

  it("returns an identical generic 404 for a bad token and for other routes", async () => {
    const env = makeEnv();
    const badToken = await worker.fetch(pageRequest("/r/not-a-real-token"), env);
    const badRoute = await worker.fetch(pageRequest("/nope"), env);
    const badMethod = await worker.fetch(pageRequest(`/r/${TOKEN}`, "DELETE"), env);

    const [bodyA, bodyB, bodyC] = await Promise.all([
      badToken.text(),
      badRoute.text(),
      badMethod.text(),
    ]);

    expect(badToken.status).toBe(404);
    expect(badRoute.status).toBe(404);
    expect(badMethod.status).toBe(404);
    expect(bodyA).toBe(bodyB);
    expect(bodyA).toBe(bodyC);
  });
});

describe("POST /r/:token/ring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls Discord once with allowed_mentions pinned to the resident", async () => {
    const env = makeEnv();
    const res = await worker.fetch(ringRequest(TOKEN, { name: "Maya" }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(WEBHOOK_URL);
    const payload = JSON.parse(calledInit.body as string);
    expect(payload.allowed_mentions.users).toEqual([RESIDENT_ID]);
    expect(payload.content).toContain("Maya");
    expect(payload.content).toContain(LABEL);
  });

  it("sanitizes a name containing mention and markdown characters", async () => {
    const env = makeEnv();
    await worker.fetch(ringRequest(TOKEN, { name: "@everyone **hi** <@123>" }), env);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const content: string = payload.content;
    const visitorName = content.match(/\u{1F514} (.*) is at your door/u)![1];
    expect(visitorName).not.toContain("@");
    expect(visitorName).not.toContain("*");
    expect(visitorName).not.toContain("<");
    expect(visitorName).not.toContain(">");
  });

  it("cuts a name over 40 characters to 40, and defaults empty/non-string names to Someone", async () => {
    const env = makeEnv();
    const longName = "x".repeat(60);
    await worker.fetch(ringRequest(TOKEN, { name: longName }), env);
    let payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const usedName = payload.content.match(/\u{1F514} (.*) is at your door/u)![1];
    expect(usedName.length).toBeLessThanOrEqual(40);

    fetchMock.mockClear();
    const env2 = makeEnv();
    await worker.fetch(ringRequest(TOKEN, { name: "" }), env2);
    payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.content).toContain("\u{1F514} Someone is at your door");

    fetchMock.mockClear();
    const env3 = makeEnv();
    await worker.fetch(ringRequest(TOKEN, { name: 42 }), env3);
    payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.content).toContain("\u{1F514} Someone is at your door");
  });

  it("returns 429 and skips Discord on a second ring within 60 seconds", async () => {
    const env = makeEnv();
    const first = await worker.fetch(ringRequest(TOKEN, { name: "Maya" }), env);
    expect(first.status).toBe(200);

    const second = await worker.fetch(ringRequest(TOKEN, { name: "Maya" }), env);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ ok: false, error: "cooldown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 429 once the hourly cap is reached, and the counter resets in the next hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));

    const env = makeEnv({ HOURLY_CAP: "2" });
    // Different tokens avoid the per-tag cooldown while still sharing the hourly cap.
    const tags = { a: LABEL, b: LABEL, c: LABEL };
    const envWithTags = { ...env, TAGS: JSON.stringify(tags) };

    const r1 = await worker.fetch(ringRequest("a", { name: "One" }), envWithTags);
    const r2 = await worker.fetch(ringRequest("b", { name: "Two" }), envWithTags);
    const r3 = await worker.fetch(ringRequest("c", { name: "Three" }), envWithTags);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(await r3.json()).toEqual({ ok: false, error: "cap" });

    vi.setSystemTime(new Date("2026-11-26T11:00:00Z"));
    const r4 = await worker.fetch(ringRequest("c", { name: "Three" }), envWithTags);
    expect(r4.status).toBe(200);

    vi.useRealTimers();
  });

  it("returns 502, clears the cooldown key, and leaks no webhook info on a Discord failure", async () => {
    fetchMock.mockImplementation(async () => new Response("fail", { status: 500 }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeEnv();
    const res = await worker.fetch(ringRequest(TOKEN, { name: "Maya" }), env);
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(text).not.toContain(WEBHOOK_URL);
    for (const call of consoleErrorSpy.mock.calls) {
      expect(call.join(" ")).not.toContain(WEBHOOK_URL);
    }

    // Cooldown was cleared, so a retry is allowed immediately.
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    const retry = await worker.fetch(ringRequest(TOKEN, { name: "Maya" }), env);
    expect(retry.status).toBe(200);

    consoleErrorSpy.mockRestore();
  });

  it("handles a malformed JSON body without a 500", async () => {
    const env = makeEnv();
    const req = new Request(`https://example.com/r/${TOKEN}/ring`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 for an unknown token", async () => {
    const env = makeEnv();
    const res = await worker.fetch(ringRequest("unknown-token", { name: "Maya" }), env);
    expect(res.status).toBe(404);
  });
});

describe("sanitizeName", () => {
  it("returns Someone for non-string input", () => {
    expect(sanitizeName(undefined)).toBe("Someone");
    expect(sanitizeName(null)).toBe("Someone");
    expect(sanitizeName(123)).toBe("Someone");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeName("  Maya   G  ")).toBe("Maya G");
  });
});

describe("visitor page", () => {
  const html = renderPage("Luke");

  it("is headed Ring the bell", () => {
    expect(html).toContain("<h1>Ring the bell</h1>");
    expect(html).not.toContain("know you're here");
  });

  it("asks for the name in its own field, not a browser pop-up", () => {
    expect(html).not.toContain("prompt(");
    expect(html).toContain('<label for="visitor-name">');
    expect(html).toMatch(/<input id="visitor-name"[^>]*maxlength="40"/);
  });
});

describe("asking for the name", () => {
  // Runs the page's own script against a minimal stand-in for the browser.
  async function visit(saved: Map<string, string>, typed = "") {
    const field = { hidden: true };
    const input = { value: "", blur() {} };
    let submit = (_event: { preventDefault(): void }) => {};
    const sent: string[] = [];
    const elements: Record<string, unknown> = {
      "name-field": field,
      "visitor-name": input,
      "ring-form": { addEventListener: (_type: string, listener: typeof submit) => (submit = listener) },
      "ring-button": { disabled: false },
      status: { textContent: "" },
    };
    const script = renderPage("Luke").split("<script>")[1].split("</script>")[0];
    new Function("document", "localStorage", "location", "fetch", "setTimeout", script)(
      { getElementById: (id: string) => elements[id] },
      {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
      },
      { pathname: "/r/token" },
      async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body).name);
        return new Response(JSON.stringify({ ok: true }));
      },
      () => 0,
    );
    const asked = !field.hidden;
    if (asked) input.value = typed;
    submit({ preventDefault() {} });
    return { asked, sent: sent[0], hiddenAfter: field.hidden };
  }

  it("asks on the first visit only, and sends the saved name afterwards", async () => {
    const saved = new Map<string, string>();

    expect(await visit(saved, " Maya ")).toEqual({ asked: true, sent: "Maya", hiddenAfter: true });
    expect(await visit(saved)).toEqual({ asked: false, sent: "Maya", hiddenAfter: true });
  });

  it("does not ask again someone who left it blank", async () => {
    const saved = new Map<string, string>();
    await visit(saved, "");

    expect(await visit(saved)).toEqual({ asked: false, sent: "", hiddenAfter: true });
  });
});
