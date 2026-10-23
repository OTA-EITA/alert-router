import { parse } from "yaml";
import { z } from "zod";

const durationRe = /^(\d+)(ms|s|m|h)$/;
const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Parses "500ms", "30s", "10m" or "1h" into milliseconds. */
export function parseDuration(s: string): number {
  const m = durationRe.exec(s);
  if (!m?.[1] || !m[2]) throw new Error(`invalid duration "${s}" (want e.g. 30s, 10m, 1h)`);
  return Number(m[1]) * unitMs[m[2] as keyof typeof unitMs];
}

const receiverSchema = z.strictObject({
  name: z.string().min(1),
  slack: z.strictObject({
    // The webhook URL is a secret, so the file only names the environment variable holding it.
    webhook_url_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name"),
    mention: z.string().optional(),
  }),
});

const routeSchema = z.strictObject({
  receiver: z.string().min(1),
  match: z.record(z.string(), z.string()).default({}),
  match_re: z.record(z.string(), z.string()).default({}),
  continue: z.boolean().default(false),
});

const fileSchema = z.strictObject({
  receivers: z.array(receiverSchema).min(1),
  routes: z.array(routeSchema).default([]),
  default_receiver: z.string().min(1),
  runbook_base_url: z.url({ protocol: /^https$/ }).optional(),
  dedup_window: z.string().default("10m"),
  allowed_webhook_hosts: z.array(z.string().min(1)).default(["hooks.slack.com"]),
});

export interface Receiver {
  name: string;
  webhookUrl: URL;
  mention?: string;
}

export interface Route {
  receiver: string;
  match: Record<string, string>;
  matchRe: Record<string, RegExp>;
  continue: boolean;
}

export interface Config {
  receivers: Map<string, Receiver>;
  routes: Route[];
  defaultReceiver: string;
  runbookBaseUrl?: string;
  dedupWindowMs: number;
}

/** Parses and validates the YAML config, resolving webhook URLs from the environment. */
export function loadConfig(source: string, env: Record<string, string | undefined>): Config {
  const parsed = fileSchema.safeParse(parse(source));
  if (!parsed.success) {
    throw new Error(
      "invalid config:\n" +
        parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  const file = parsed.data;
  const errors: string[] = [];

  const receivers = new Map<string, Receiver>();
  for (const r of file.receivers) {
    if (receivers.has(r.name)) errors.push(`receiver "${r.name}" is defined twice`);
    const raw = env[r.slack.webhook_url_env];
    if (!raw) {
      errors.push(`receiver "${r.name}": environment variable ${r.slack.webhook_url_env} is not set`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      errors.push(`receiver "${r.name}": ${r.slack.webhook_url_env} is not a URL`);
      continue;
    }
    // Only post to known hosts over TLS, so a bad environment cannot send alerts (and their labels) elsewhere.
    if (url.protocol !== "https:" || !file.allowed_webhook_hosts.includes(url.hostname)) {
      errors.push(
        `receiver "${r.name}": webhook host ${url.protocol}//${url.hostname} is not in allowed_webhook_hosts`,
      );
      continue;
    }
    const receiver: Receiver = { name: r.name, webhookUrl: url };
    if (r.slack.mention !== undefined) receiver.mention = r.slack.mention;
    receivers.set(r.name, receiver);
  }

  const known = (name: string) => file.receivers.some((r) => r.name === name);
  if (!known(file.default_receiver))
    errors.push(`default_receiver "${file.default_receiver}" is not defined`);

  const routes: Route[] = file.routes.map((r, i) => {
    if (!known(r.receiver)) errors.push(`routes[${String(i)}]: receiver "${r.receiver}" is not defined`);
    const matchRe: Record<string, RegExp> = {};
    for (const [label, pattern] of Object.entries(r.match_re)) {
      try {
        // Anchored like Alertmanager matchers.
        matchRe[label] = new RegExp(`^(?:${pattern})$`);
      } catch (err) {
        errors.push(`routes[${String(i)}].match_re.${label}: ${(err as Error).message}`);
      }
    }
    return { receiver: r.receiver, match: r.match, matchRe, continue: r.continue };
  });

  let dedupWindowMs = 0;
  try {
    dedupWindowMs = parseDuration(file.dedup_window);
  } catch (err) {
    errors.push(`dedup_window: ${(err as Error).message}`);
  }

  if (errors.length) throw new Error("invalid config:\n" + errors.map((e) => `  ${e}`).join("\n"));
  const config: Config = { receivers, routes, defaultReceiver: file.default_receiver, dedupWindowMs };
  if (file.runbook_base_url !== undefined) config.runbookBaseUrl = file.runbook_base_url;
  return config;
}
