import type { Alert } from "./alertmanager.js";

/** Block Kit payload for an incoming webhook. */
export interface SlackMessage {
  text: string;
  blocks: Record<string, unknown>[];
}

export interface MessageOptions {
  externalURL: string;
  runbookBaseUrl?: string;
  mention?: string;
}

// Slack allows 50 blocks; keep room for the header, footer and dividers.
const maxAlerts = 10;
const maxText = 2900;

/**
 * Escapes Slack mrkdwn control characters. Label values come from whatever is
 * being monitored, so without this a label could inject links or <!channel>.
 */
export function escape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(s: string, n = maxText): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function httpUrl(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** The alert's runbook_url annotation, else <runbookBaseUrl>/<alertname in kebab case>. */
export function runbookUrl(alert: Alert, base: string | undefined): string | undefined {
  const own = httpUrl(alert.annotations.runbook_url);
  if (own) return own;
  const name = alert.labels.alertname;
  if (!base || !name) return undefined;
  const slug = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    // Split an acronym from the next word: HTTPRequests -> HTTP-Requests.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase();
  return new URL(encodeURIComponent(slug), base.endsWith("/") ? base : base + "/").href;
}

/** Alertmanager UI link that pre-fills a silence matching the alert's labels. */
export function silenceUrl(alert: Alert, externalURL: string): string | undefined {
  const base = httpUrl(externalURL);
  if (!base) return undefined;
  const matchers = Object.entries(alert.labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(",");
  return `${base.replace(/\/$/, "")}/#/silences/new?filter=${encodeURIComponent(`{${matchers}}`)}`;
}

const severityIcon: Record<string, string> = { critical: "🔴", error: "🟠", warning: "🟡", info: "🔵" };

function alertBlocks(alert: Alert, opt: MessageOptions): Record<string, unknown>[] {
  const l = alert.labels;
  const a = alert.annotations;
  const icon = alert.status === "resolved" ? "✅" : (severityIcon[l.severity ?? ""] ?? "⚪");
  const title = `${icon} *${escape(l.alertname ?? "(no alertname)")}*`;
  const body = a.summary ?? a.description ?? "";
  const context = ["severity", "namespace", "service", "job", "instance", "pod"]
    .filter((k) => l[k] !== undefined)
    .map((k) => `${k}: \`${escape(l[k] ?? "")}\``)
    .join("  ");

  const buttons: Record<string, unknown>[] = [];
  const add = (text: string, url: string | undefined) => {
    if (url) buttons.push({ type: "button", text: { type: "plain_text", text }, url });
  };
  add("Runbook", runbookUrl(alert, opt.runbookBaseUrl));
  add("Source", httpUrl(alert.generatorURL));
  if (alert.status === "firing") add("Silence", silenceUrl(alert, opt.externalURL));

  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: truncate(body ? `${title}\n${escape(body)}` : title) } },
  ];
  if (context) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(context) }] });
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}

/** Builds one Slack message for the alerts a receiver gets from one webhook call. */
export function buildMessage(alerts: Alert[], opt: MessageOptions): SlackMessage {
  const firing = alerts.filter((a) => a.status === "firing").length;
  const resolved = alerts.length - firing;
  const names = [...new Set(alerts.map((a) => a.labels.alertname ?? "(no alertname)"))];
  const summary = [
    firing ? `🔥 FIRING ${String(firing)}` : "",
    resolved ? `✅ RESOLVED ${String(resolved)}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  const headline = truncate(`${summary}: ${names.join(", ")}`, 150);

  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: headline } },
  ];
  // Mentions are configured by the operator, not taken from labels, so they are not escaped.
  if (firing && opt.mention) blocks.push({ type: "section", text: { type: "mrkdwn", text: opt.mention } });
  for (const alert of alerts.slice(0, maxAlerts)) {
    blocks.push({ type: "divider" }, ...alertBlocks(alert, opt));
  }
  if (alerts.length > maxAlerts) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${String(alerts.length - maxAlerts)} more alert(s)` }],
    });
  }
  return { text: headline, blocks };
}
