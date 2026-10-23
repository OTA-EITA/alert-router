import { readFileSync } from "node:fs";
import type { Alert, Webhook } from "../src/alertmanager.js";
import { webhookSchema } from "../src/alertmanager.js";
import { loadConfig } from "../src/config.js";

export const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

export const env = {
  SLACK_PLATFORM_PAGE: "https://hooks.slack.com/services/T000/B001/page",
  SLACK_PLATFORM: "https://hooks.slack.com/services/T000/B002/platform",
  SLACK_PAYMENTS: "https://hooks.slack.com/services/T000/B003/payments",
  SLACK_CATCH_ALL: "https://hooks.slack.com/services/T000/B004/catch-all",
};

export const exampleConfig = () => loadConfig(read("examples/config.yaml"), env);

export const exampleHook = (): Webhook => webhookSchema.parse(JSON.parse(read("examples/alert.json")));

export function alert(labels: Record<string, string>, over: Partial<Alert> = {}): Alert {
  return {
    status: "firing",
    labels: { alertname: "TestAlert", ...labels },
    annotations: {},
    startsAt: "2026-10-23T00:00:00Z",
    endsAt: "",
    generatorURL: "",
    fingerprint: Object.entries(labels).flat().join("-") || "fp",
    ...over,
  };
}

export function hook(alerts: Alert[]): Webhook {
  return {
    version: "4",
    groupKey: "{}",
    truncatedAlerts: 0,
    status: alerts.some((a) => a.status === "firing") ? "firing" : "resolved",
    receiver: "alert-router",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "https://alertmanager.example.com",
    alerts,
  };
}
