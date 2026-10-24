import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { SlackMessage } from "../src/slack.js";
import { alert, env, exampleConfig, hook, read } from "./helpers.js";

const token = "test-token-0123456789";

function setup(fail: string[] = []) {
  const sent: { url: string; message: SlackMessage }[] = [];
  const logs: string[] = [];
  let t = 0;
  const { app, deduper } = createApp({
    config: exampleConfig(),
    token,
    now: () => t,
    log: (m) => logs.push(m),
    send: (url, message) => {
      if (fail.includes(url.href)) return Promise.reject(new Error("POST hooks.slack.com: HTTP 500"));
      sent.push({ url: url.href, message });
      return Promise.resolve();
    },
  });
  const post = (body: string, auth = `Bearer ${token}`) =>
    app.request("/webhook", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body,
    });
  return { app, deduper, sent, logs, post, advance: (ms: number) => (t += ms) };
}

describe("POST /webhook", () => {
  it("delivers the example to every routed receiver", async () => {
    const s = setup();
    const res = await s.post(read("examples/alert.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sent: ["payments", "platform", "platform-page"],
      failed: [],
      deduplicated: 0,
    });
    expect(s.sent.map((x) => x.url).sort()).toEqual(
      [env.SLACK_PAYMENTS, env.SLACK_PLATFORM, env.SLACK_PLATFORM_PAGE].sort(),
    );
  });

  it("requires the bearer token", async () => {
    const s = setup();
    expect((await s.post(read("examples/alert.json"), "")).status).toBe(401);
    expect((await s.post(read("examples/alert.json"), "Bearer wrong-token-0123456789")).status).toBe(401);
    expect(s.sent).toEqual([]);
  });

  it("rejects bodies that are not JSON or not Alertmanager v4", async () => {
    const s = setup();
    expect((await s.post("{")).status).toBe(400);
    const res = await s.post(JSON.stringify({ version: "3", alerts: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not an Alertmanager v4 webhook");
  });

  it("rejects oversized bodies", async () => {
    const s = setup();
    expect((await s.post("x".repeat(1024 * 1024 + 1))).status).toBe(413);
  });

  it("does not post the same alert twice within the window, but always posts the resolve", async () => {
    const s = setup();
    const firing = JSON.stringify(hook([alert({ severity: "warning", namespace: "payments" })]));
    await s.post(firing);
    const again = await s.post(firing);
    expect(await again.json()).toEqual({ sent: [], failed: [], deduplicated: 1 });
    const resolved = JSON.stringify(
      hook([alert({ severity: "warning", namespace: "payments" }, { status: "resolved" })]),
    );
    expect(await (await s.post(resolved)).json()).toMatchObject({ sent: ["payments"] });
    s.advance(10 * 60 * 1000);
    expect(await (await s.post(firing)).json()).toMatchObject({ sent: ["payments"] });
    expect(s.sent).toHaveLength(3);
  });

  it("delivers an alert that fires again after resolving (flapping)", async () => {
    const s = setup();
    const firing = alert({ namespace: "monitoring" });
    await s.post(JSON.stringify(hook([firing])));
    s.advance(60_000);
    await s.post(JSON.stringify(hook([{ ...firing, status: "resolved" }])));
    s.advance(60_000);
    const again = await s.post(JSON.stringify(hook([firing])));
    expect(await again.json()).toMatchObject({ sent: ["platform"], deduplicated: 0 });
    expect(s.sent.map((x) => x.message.text)).toEqual([
      "🔥 FIRING 1: TestAlert",
      "✅ RESOLVED 1: TestAlert",
      "🔥 FIRING 1: TestAlert",
    ]);
  });

  it("answers 502 on a failed delivery so Alertmanager retries only what failed", async () => {
    const s = setup([env.SLACK_PAYMENTS]);
    const body = JSON.stringify(hook([alert({ severity: "critical", namespace: "payments" })]));
    const first = await s.post(body);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ sent: ["platform-page"], failed: ["payments"], deduplicated: 0 });
    expect(s.logs).toEqual(["delivery to payments failed: POST hooks.slack.com: HTTP 500"]);
    // The retry is not deduplicated for the receiver that failed.
    const retry = await s.post(body);
    expect(await retry.json()).toEqual({ sent: [], failed: ["payments"], deduplicated: 1 });
  });
});

describe("GET endpoints", () => {
  it("/healthz", async () => {
    const res = await setup().app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("/metrics counts webhooks, notifications and deduplication", async () => {
    const s = setup();
    const body = JSON.stringify(hook([alert({ namespace: "monitoring" })]));
    await s.post(body);
    await s.post(body);
    await s.post("{");
    const res = await s.app.request("/metrics");
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await res.text();
    expect(text).toContain('alert_router_webhooks_total{result="ok"} 2');
    expect(text).toContain('alert_router_webhooks_total{result="invalid"} 1');
    expect(text).toContain('alert_router_notifications_total{receiver="platform",result="sent"} 1');
    expect(text).toContain('alert_router_deduplicated_total{receiver="platform"} 1');
    expect(text).toContain("# TYPE alert_router_webhooks_total counter");
  });
});
