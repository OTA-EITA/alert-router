import { describe, expect, it } from "vitest";
import { loadConfig, parseDuration } from "../src/config.js";
import { env, exampleConfig } from "./helpers.js";

const minimal = (extra = "") => `
receivers:
  - name: a
    slack: { webhook_url_env: SLACK_A }
default_receiver: a
${extra}`;
const envA = { SLACK_A: "https://hooks.slack.com/services/x" };

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["10m", 600_000],
    ["1h", 3_600_000],
  ])("%s", (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });

  it("rejects other formats", () => {
    expect(() => parseDuration("10")).toThrow(/invalid duration/);
    expect(() => parseDuration("1d")).toThrow(/invalid duration/);
  });
});

describe("loadConfig", () => {
  it("loads the example", () => {
    const c = exampleConfig();
    expect([...c.receivers.keys()]).toEqual(["platform-page", "platform", "payments", "catch-all"]);
    expect(c.receivers.get("platform-page")?.mention).toBe("<!subteam^S0123456789>");
    expect(c.receivers.get("payments")?.webhookUrl.href).toBe(env.SLACK_PAYMENTS);
    expect(c.routes[1]?.matchRe.namespace?.test("payments-api")).toBe(true);
    expect(c.dedupWindowMs).toBe(600_000);
    expect(c.runbookBaseUrl).toBe("https://runbooks.example.com/alerts/");
  });

  it("anchors match_re like Alertmanager", () => {
    const c = loadConfig(minimal("routes: [{ receiver: a, match_re: { env: 'prod|stg' } }]"), envA);
    const re = c.routes[0]?.matchRe.env;
    expect(re?.test("prod")).toBe(true);
    expect(re?.test("preprod")).toBe(false);
    expect(re?.test("prod-2")).toBe(false);
  });

  it("applies defaults", () => {
    const c = loadConfig(minimal(), envA);
    expect(c.routes).toEqual([]);
    expect(c.dedupWindowMs).toBe(600_000);
    expect(c.runbookBaseUrl).toBeUndefined();
  });

  it("reports schema errors with their path", () => {
    expect(() => loadConfig("receivers: []\ndefault_receiver: a\n", {})).toThrow(/receivers: /);
    expect(() => loadConfig(minimal("unknown_key: 1"), envA)).toThrow(/unknown_key|Unrecognized/);
    expect(() =>
      loadConfig("receivers: [{ name: a, slack: { webhook_url_env: lower } }]\ndefault_receiver: a", {}),
    ).toThrow(/receivers.0.slack.webhook_url_env: must be an environment variable name/);
    expect(() => loadConfig(minimal("runbook_base_url: http://insecure.example.com/"), envA)).toThrow(
      /runbook_base_url/,
    );
  });

  it("collects every semantic error at once", () => {
    const src = `
receivers:
  - name: a
    slack: { webhook_url_env: SLACK_A }
  - name: a
    slack: { webhook_url_env: SLACK_A }
  - name: missing
    slack: { webhook_url_env: SLACK_MISSING }
  - name: bad
    slack: { webhook_url_env: SLACK_BAD }
routes:
  - receiver: nope
  - receiver: a
    match_re: { x: "(" }
default_receiver: ghost
dedup_window: soon
`;
    let message = "";
    try {
      loadConfig(src, { ...envA, SLACK_BAD: "not a url" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('receiver "a" is defined twice');
    expect(message).toContain("SLACK_MISSING is not set");
    expect(message).toContain("SLACK_BAD is not a URL");
    expect(message).toContain('routes[0]: receiver "nope" is not defined');
    expect(message).toContain("routes[1].match_re.x:");
    expect(message).toContain('default_receiver "ghost" is not defined');
    expect(message).toContain('dedup_window: invalid duration "soon"');
  });

  it("only posts to allowed hosts over https", () => {
    expect(() => loadConfig(minimal(), { SLACK_A: "https://evil.example.com/hook" })).toThrow(
      /https:\/\/evil.example.com is not in allowed_webhook_hosts/,
    );
    expect(() => loadConfig(minimal(), { SLACK_A: "http://hooks.slack.com/services/x" })).toThrow(
      /not in allowed_webhook_hosts/,
    );
    const c = loadConfig(minimal("allowed_webhook_hosts: [chat.example.com]"), {
      SLACK_A: "https://chat.example.com/hooks/1",
    });
    expect(c.receivers.get("a")?.webhookUrl.hostname).toBe("chat.example.com");
  });

  it("uses placeholders instead of secrets for dry runs", () => {
    const c = loadConfig(minimal(), {}, { resolveSecrets: false });
    expect(c.receivers.get("a")?.webhookUrl.href).toBe("https://hooks.slack.com/dry-run");
  });
});
