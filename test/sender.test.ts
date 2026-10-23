import { describe, expect, it } from "vitest";
import { slackSender } from "../src/sender.js";

const url = new URL("https://hooks.slack.com/services/T0/B0/secret-token");
const message = { text: "hi", blocks: [] };

function fakeFetch(statuses: (number | [number, Record<string, string>])[]) {
  const calls: RequestInit[] = [];
  const fn = (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = statuses.shift() ?? 200;
    const [status, headers] = Array.isArray(next) ? next : [next, {}];
    return Promise.resolve(new Response(null, { status, headers }));
  };
  return { fetch: fn, calls };
}

describe("slackSender", () => {
  it("posts JSON once on success, refusing redirects", async () => {
    const f = fakeFetch([200]);
    await slackSender({ fetch: f.fetch })(url, message);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(message) });
  });

  it("retries 429 using Retry-After, capped, and 5xx with backoff", async () => {
    const waits: number[] = [];
    const f = fakeFetch([[429, { "retry-after": "2" }], [429, { "retry-after": "3600" }], 503, 200]);
    await slackSender({ fetch: f.fetch, sleep: (ms) => (waits.push(ms), Promise.resolve()) })(url, message);
    expect(f.calls).toHaveLength(4);
    expect(waits).toEqual([2000, 30_000, 2000]);
  });

  it("gives up after the retries without leaking the secret URL", async () => {
    const f = fakeFetch([500, 500, 500]);
    const send = slackSender({ fetch: f.fetch, retries: 2, sleep: () => Promise.resolve() });
    const err = await send(url, message).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("POST hooks.slack.com: HTTP 500");
    expect(err?.message).not.toContain("secret-token");
    expect(f.calls).toHaveLength(3);
  });

  it("does not retry client errors", async () => {
    const f = fakeFetch([404]);
    await expect(slackSender({ fetch: f.fetch })(url, message)).rejects.toThrow("HTTP 404");
    expect(f.calls).toHaveLength(1);
  });
});
