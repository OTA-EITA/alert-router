import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { webhookSchema } from "./alertmanager.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { plan } from "./dispatch.js";
import { slackSender } from "./sender.js";

declare const __VERSION__: string | undefined;
const version = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const usage = `usage: alert-router <command> [options]

commands:
  serve                  receive Alertmanager webhooks and post them to Slack
  check                  validate the config and that every webhook URL is set
  route <payload.json>   dry run: show where a webhook payload would go and the
                         Slack message, without sending ("-" reads stdin)

options:
  --config <path>        routing config (default: $ALERT_ROUTER_CONFIG or config.yaml)
  --port <port>          listen port for serve (default: $PORT or 9095)
  --json                 route: print the full Slack payloads as JSON
  --version              print the version and exit
  -h, --help             show this help

serve reads the shared secret Alertmanager sends as a bearer token from
$ALERT_ROUTER_TOKEN (at least 16 characters).
`;

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
  /** Starts the HTTP server; replaced in tests. */
  listen: (fetch: (req: Request) => Response | Promise<Response>, port: number) => void;
}

export function main(argv: string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        port: { type: "string" },
        json: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(usage);
    return 0;
  }
  if (values.version) {
    io.stdout(`alert-router ${version}\n`);
    return 0;
  }
  const [command, ...args] = positionals;
  const configPath = values.config ?? io.env.ALERT_ROUTER_CONFIG ?? "config.yaml";

  try {
    switch (command) {
      case "check": {
        const config = loadConfig(io.readFile(configPath), io.env);
        io.stdout(
          `${configPath}: OK (${String(config.receivers.size)} receiver(s), ${String(config.routes.length)} route(s))\n`,
        );
        return 0;
      }
      case "route": {
        const [payloadPath] = args;
        if (!payloadPath) throw new Error("route needs a payload file (or - for stdin)");
        const config = loadConfig(io.readFile(configPath), io.env, { resolveSecrets: false });
        const hook = webhookSchema.parse(
          JSON.parse(io.readFile(payloadPath === "-" ? "/dev/stdin" : payloadPath)),
        );
        const deliveries = plan(config, hook);
        if (values.json) {
          io.stdout(
            JSON.stringify(
              deliveries.map((d) => ({ receiver: d.receiver, message: d.message })),
              null,
              2,
            ) + "\n",
          );
          return 0;
        }
        for (const d of deliveries) {
          io.stdout(`${d.receiver}: ${d.message.text}\n`);
          for (const a of d.alerts) {
            io.stdout(
              `  - ${a.status.padEnd(8)} ${a.labels.alertname ?? "(no alertname)"} ${a.fingerprint}\n`,
            );
          }
        }
        return 0;
      }
      case "serve": {
        const token = io.env.ALERT_ROUTER_TOKEN ?? "";
        if (token.length < 16) throw new Error("ALERT_ROUTER_TOKEN must be set to at least 16 characters");
        const port = Number(values.port ?? io.env.PORT ?? "9095");
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error(`invalid port "${String(port)}"`);
        const config = loadConfig(io.readFile(configPath), io.env);
        const log = (m: string) => {
          io.stderr(`${m}\n`);
        };
        const { app } = createApp({ config, send: slackSender(), token, log });
        io.listen(app.fetch, port);
        io.stderr(`alert-router ${version} listening on :${String(port)}\n`);
        return 0;
      }
      default:
        io.stderr(`error: unknown command "${command ?? ""}"\n\n${usage}`);
        return 2;
    }
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

/** True when this module is the program being run, also through a symlink. */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Exercised by the container smoke test in CI rather than unit tests.
/* v8 ignore start */
if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
    listen: (fetch, port) => {
      const server = serve({ fetch, port });
      // Kubernetes sends SIGTERM; finish in-flight webhooks before exiting.
      const stop = () => {
        server.close(() => {
          process.exit(0);
        });
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
  });
}
/* v8 ignore stop */
