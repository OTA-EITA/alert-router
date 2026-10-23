import type { Config, Route } from "./config.js";

export function matches(route: Route, labels: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(route.match)) {
    if (labels[k] !== v) return false;
  }
  for (const [k, re] of Object.entries(route.matchRe)) {
    // A missing label matches like the empty string, as in Alertmanager.
    if (!re.test(labels[k] ?? "")) return false;
  }
  return true;
}

/**
 * Picks the receivers for an alert: routes are tried in order and the first
 * match wins unless it sets `continue`. Without any match the alert goes to
 * the default receiver, so nothing is dropped silently.
 */
export function routeAlert(config: Config, labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const r of config.routes) {
    if (!matches(r, labels)) continue;
    if (!out.includes(r.receiver)) out.push(r.receiver);
    if (!r.continue) break;
  }
  return out.length ? out : [config.defaultReceiver];
}
