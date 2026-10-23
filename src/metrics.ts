/** Minimal Prometheus counters, enough for the router's own /metrics. */
export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {}

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = this.labelNames.map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`).join(",");
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, v] of [...this.values].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${String(v)}`);
    }
    return lines.join("\n") + "\n";
  }
}

function escapeLabel(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function createMetrics() {
  return {
    received: new Counter("alert_router_webhooks_total", "Webhook requests by result.", ["result"]),
    notifications: new Counter(
      "alert_router_notifications_total",
      "Slack notifications by receiver and result.",
      ["receiver", "result"],
    ),
    deduplicated: new Counter(
      "alert_router_deduplicated_total",
      "Alerts not sent again within the dedup window.",
      ["receiver"],
    ),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function renderMetrics(m: Metrics): string {
  return Object.values(m)
    .map((c) => c.render())
    .join("");
}
