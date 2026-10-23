import { describe, expect, it } from "vitest";
import { buildMessage, escape, runbookUrl, silenceUrl } from "../src/slack.js";
import { alert, exampleHook } from "./helpers.js";

const opt = { externalURL: "https://alertmanager.example.com" };
const json = (v: unknown) => JSON.stringify(v);

describe("escape", () => {
  it("neutralises links and broadcast mentions from labels", () => {
    expect(escape("<!channel> <https://evil.example|click> & co")).toBe(
      "&lt;!channel&gt; &lt;https://evil.example|click&gt; &amp; co",
    );
  });
});

describe("runbookUrl", () => {
  it("prefers the runbook_url annotation", () => {
    const a = alert({}, { annotations: { runbook_url: "https://wiki.example.com/rb" } });
    expect(runbookUrl(a, "https://runbooks.example.com/")).toBe("https://wiki.example.com/rb");
  });

  it("derives a kebab-case page from the alert name", () => {
    expect(runbookUrl(alert({ alertname: "KubePodCrashLooping" }), "https://rb.example.com/alerts")).toBe(
      "https://rb.example.com/alerts/kube-pod-crash-looping",
    );
    expect(runbookUrl(alert({ alertname: "HTTP5xxRate high" }), "https://rb.example.com/")).toBe(
      "https://rb.example.com/http5xx-rate-high",
    );
  });

  it("ignores non-http annotations and works without a base", () => {
    const a = alert({}, { annotations: { runbook_url: "javascript:alert(1)" } });
    expect(runbookUrl(a, undefined)).toBeUndefined();
    expect(runbookUrl(alert({}, { annotations: { runbook_url: "not a url" } }), undefined)).toBeUndefined();
    expect(runbookUrl({ ...alert({}), labels: {} }, "https://rb.example.com/")).toBeUndefined();
  });
});

describe("silenceUrl", () => {
  it("pre-fills a silence with every label, sorted", () => {
    const url = silenceUrl(alert({ severity: "critical", namespace: "a" }), "https://am.example.com/");
    expect(url).toBe(
      "https://am.example.com/#/silences/new?filter=" +
        encodeURIComponent('{alertname="TestAlert",namespace="a",severity="critical"}'),
    );
  });

  it("needs an http(s) Alertmanager URL", () => {
    expect(silenceUrl(alert({}), "")).toBeUndefined();
  });
});

describe("buildMessage", () => {
  it("renders the example payload", () => {
    const m = buildMessage(exampleHook().alerts, { ...opt, runbookBaseUrl: "https://rb.example.com/" });
    expect(m.text).toBe("🔥 FIRING 1 / ✅ RESOLVED 1: KubePodCrashLooping, KubeDeploymentReplicasMismatch");
    expect(m.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: m.text } });
    const s = json(m.blocks);
    expect(s).toContain("🔴 *KubePodCrashLooping*\\nPod payments-api/checkout-7d9f8b6c5-x2k4p (app)");
    expect(s).toContain("severity: `critical`  namespace: `payments-api`  pod: `checkout-7d9f8b6c5-x2k4p`");
    expect(s).toContain("https://runbooks.prometheus-operator.dev/runbooks/kubernetes/kubepodcrashlooping");
    expect(s).toContain("✅ *KubeDeploymentReplicasMismatch*");
    expect(s).toContain("https://rb.example.com/kube-deployment-replicas-mismatch");
  });

  it("offers Silence only while firing", () => {
    const firing = json(buildMessage([alert({})], opt).blocks);
    const resolved = json(buildMessage([alert({}, { status: "resolved" })], opt).blocks);
    expect(firing).toContain('"Silence"');
    expect(resolved).not.toContain('"Silence"');
  });

  it("mentions only for firing alerts", () => {
    const withMention = { ...opt, mention: "<!subteam^S1>" };
    expect(json(buildMessage([alert({})], withMention).blocks)).toContain("<!subteam^S1>");
    expect(json(buildMessage([alert({}, { status: "resolved" })], withMention).blocks)).not.toContain(
      "subteam",
    );
  });

  it("escapes attacker-controlled text", () => {
    const m = buildMessage(
      [alert({ alertname: "<!channel>", namespace: "<@U1>" }, { annotations: { summary: "<!here>" } })],
      opt,
    );
    const s = json(m.blocks.slice(1));
    expect(s).not.toMatch(/<!channel>|<!here>|<@U1>/);
    expect(s).toContain("&lt;!here&gt;");
  });

  it("caps the number of alerts and long texts", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      alert({ alertname: `A${String(i)}` }, { annotations: { description: "x".repeat(5000) } }),
    );
    const m = buildMessage(many, opt);
    expect(json(m.blocks)).toContain("…and 3 more alert(s)");
    expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(m.text.length).toBeLessThanOrEqual(150);
    for (const b of m.blocks) {
      const text = (b as { text?: { text: string } }).text?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("handles alerts without name or severity", () => {
    const m = buildMessage([{ ...alert({}), labels: {} }], opt);
    expect(m.text).toBe("🔥 FIRING 1: (no alertname)");
    expect(json(m.blocks)).toContain("⚪ *(no alertname)*");
  });
});
