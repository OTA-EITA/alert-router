import type { Alert, Webhook } from "./alertmanager.js";
import type { Config } from "./config.js";
import type { Deduper } from "./dedup.js";
import type { Metrics } from "./metrics.js";
import { routeAlert } from "./route.js";
import type { Send } from "./sender.js";
import { buildMessage } from "./slack.js";
import type { SlackMessage } from "./slack.js";

export interface Delivery {
  receiver: string;
  alerts: Alert[];
  message: SlackMessage;
}

/** Decides which receiver gets which alerts and what message, without sending anything. */
export function plan(
  config: Config,
  hook: Webhook,
  keep: (receiver: string, alert: Alert) => boolean = () => true,
) {
  const byReceiver = new Map<string, Alert[]>();
  for (const alert of hook.alerts) {
    for (const receiver of routeAlert(config, alert.labels)) {
      if (!keep(receiver, alert)) continue;
      const list = byReceiver.get(receiver) ?? [];
      list.push(alert);
      byReceiver.set(receiver, list);
    }
  }
  const deliveries: Delivery[] = [];
  for (const [name, alerts] of byReceiver) {
    const receiver = config.receivers.get(name);
    const opt: Parameters<typeof buildMessage>[1] = { externalURL: hook.externalURL };
    if (config.runbookBaseUrl !== undefined) opt.runbookBaseUrl = config.runbookBaseUrl;
    if (receiver?.mention !== undefined) opt.mention = receiver.mention;
    deliveries.push({ receiver: name, alerts, message: buildMessage(alerts, opt) });
  }
  return deliveries;
}

export const dedupKey = (receiver: string, alert: Alert) =>
  `${receiver}\u0000${alert.fingerprint}\u0000${alert.status}`;

export interface DispatchResult {
  sent: string[];
  failed: string[];
  deduplicated: number;
}

/**
 * Sends each receiver's alerts. Failed deliveries are forgotten by the deduper
 * so that Alertmanager's retry (triggered by our non-2xx answer) is not swallowed.
 */
export async function dispatch(
  config: Config,
  hook: Webhook,
  deps: { send: Send; deduper: Deduper; metrics: Metrics; log?: (message: string) => void },
): Promise<DispatchResult> {
  let deduplicated = 0;
  const deliveries = plan(config, hook, (receiver, alert) => {
    if (deps.deduper.firstSeen(dedupKey(receiver, alert))) return true;
    deduplicated++;
    deps.metrics.deduplicated.inc({ receiver });
    return false;
  });

  const result: DispatchResult = { sent: [], failed: [], deduplicated };
  await Promise.all(
    deliveries.map(async (d) => {
      const receiver = config.receivers.get(d.receiver);
      try {
        if (!receiver) throw new Error(`unknown receiver ${d.receiver}`);
        await deps.send(receiver.webhookUrl, d.message);
        result.sent.push(d.receiver);
        deps.metrics.notifications.inc({ receiver: d.receiver, result: "sent" });
      } catch (err) {
        deps.log?.(`delivery to ${d.receiver} failed: ${(err as Error).message}`);
        for (const a of d.alerts) deps.deduper.forget(dedupKey(d.receiver, a));
        result.failed.push(d.receiver);
        deps.metrics.notifications.inc({ receiver: d.receiver, result: "failed" });
      }
    }),
  );
  result.sent.sort();
  result.failed.sort();
  return result;
}
