import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { webhookSchema } from "./alertmanager.js";
import type { Config } from "./config.js";
import { Deduper } from "./dedup.js";
import { dispatch } from "./dispatch.js";
import { createMetrics, renderMetrics } from "./metrics.js";
import type { Send } from "./sender.js";

export interface AppOptions {
  config: Config;
  send: Send;
  /** Shared secret Alertmanager sends as a bearer token (http_config.authorization). */
  token: string;
  now?: () => number;
  log?: (message: string) => void;
}

// Alertmanager caps a group at max_alerts; 1 MiB is far above a sane group.
const maxBodyBytes = 1024 * 1024;

export function createApp(opt: AppOptions) {
  const metrics = createMetrics();
  const deduper = new Deduper(opt.config.dedupWindowMs, opt.now);
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok\n"));
  app.get("/metrics", (c) =>
    c.text(renderMetrics(metrics), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }),
  );

  app.post(
    "/webhook",
    bearerAuth({ token: opt.token }),
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => {
        metrics.received.inc({ result: "too_large" });
        return c.json({ error: "payload too large" }, 413);
      },
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        metrics.received.inc({ result: "invalid" });
        return c.json({ error: "body is not JSON" }, 400);
      }
      const parsed = webhookSchema.safeParse(body);
      if (!parsed.success) {
        metrics.received.inc({ result: "invalid" });
        // 4xx tells Alertmanager not to retry a payload that will never be valid.
        return c.json(
          {
            error: "not an Alertmanager v4 webhook",
            issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
          },
          400,
        );
      }
      const deps = opt.log
        ? { send: opt.send, deduper, metrics, log: opt.log }
        : { send: opt.send, deduper, metrics };
      const result = await dispatch(opt.config, parsed.data, deps);
      // 5xx makes Alertmanager retry; receivers that already got it are skipped by the deduper.
      metrics.received.inc({ result: result.failed.length ? "failed" : "ok" });
      return c.json(result, result.failed.length ? 502 : 200);
    },
  );

  return { app, metrics, deduper };
}
