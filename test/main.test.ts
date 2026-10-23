import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntryPoint, main } from "../src/main.js";
import { env } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[], extraEnv: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const listened: number[] = [];
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const code = main(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { ...env, ...extraEnv },
    readFile: (p) => readFileSync(path.resolve(root, p), "utf8"),
    listen: (fetch, port) => {
      handler = fetch;
      listened.push(port);
    },
  });
  return { code, stdout, stderr, listened, handler };
}

const cfg = ["--config", "examples/config.yaml"];

describe("main", () => {
  it("check validates config and secrets", () => {
    expect(run(["check", ...cfg])).toMatchObject({
      code: 0,
      stdout: "examples/config.yaml: OK (4 receiver(s), 3 route(s))\n",
    });
    const bad = run(["check", ...cfg], { SLACK_PAYMENTS: "" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("SLACK_PAYMENTS is not set");
  });

  it("route works without any Slack secrets", () => {
    const noSecrets = Object.fromEntries(Object.keys(env).map((k) => [k, ""]));
    expect(run(["route", ...cfg, "examples/alert.json"], noSecrets).code).toBe(0);
  });

  it("route prints receivers and alerts", () => {
    const r = run(["route", ...cfg, "examples/alert.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "platform-page: 🔥 FIRING 1: KubePodCrashLooping",
        "  - firing   KubePodCrashLooping a3f5c9e1b2d4f6a8",
        "payments: 🔥 FIRING 1: KubePodCrashLooping",
        "  - firing   KubePodCrashLooping a3f5c9e1b2d4f6a8",
        "platform: ✅ RESOLVED 1: KubeDeploymentReplicasMismatch",
        "  - resolved KubeDeploymentReplicasMismatch 7c1e2d3f4a5b6c7d",
        "",
      ].join("\n"),
    );
  });

  it("route --json prints Slack payloads", () => {
    const r = run(["route", "--json", ...cfg, "examples/alert.json"]);
    const out = JSON.parse(r.stdout) as { receiver: string; message: { blocks: unknown[] } }[];
    expect(out.map((d) => d.receiver)).toEqual(["platform-page", "payments", "platform"]);
    expect(out[0]?.message.blocks.length).toBeGreaterThan(2);
  });

  it("route rejects a missing or invalid payload", () => {
    expect(run(["route", ...cfg]).stderr).toContain("route needs a payload file");
    expect(run(["route", ...cfg, "examples/config.yaml"]).code).toBe(1);
  });

  it("serve requires a strong token and a valid port", () => {
    expect(run(["serve", ...cfg]).stderr).toContain("ALERT_ROUTER_TOKEN must be set");
    expect(run(["serve", ...cfg], { ALERT_ROUTER_TOKEN: "short" }).code).toBe(1);
    const token = { ALERT_ROUTER_TOKEN: "0123456789abcdef" };
    expect(run(["serve", ...cfg, "--port", "0"], token).stderr).toContain('invalid port "0"');
    expect(run(["serve", ...cfg, "--port", "x"], token).code).toBe(1);
  });

  it("serve listens on $PORT or 9095 and answers health checks", async () => {
    const token = { ALERT_ROUTER_TOKEN: "0123456789abcdef" };
    expect(run(["serve", ...cfg], token).listened).toEqual([9095]);
    const r = run(["serve", ...cfg], { ...token, PORT: "8080" });
    expect(r.code).toBe(0);
    expect(r.listened).toEqual([8080]);
    expect(r.stderr).toBe("alert-router dev listening on :8080\n");
    const res = await r.handler?.(new Request("http://localhost/healthz"));
    expect(await res?.text()).toBe("ok\n");
  });

  it("reads the config path from the environment", () => {
    expect(run(["check"], { ALERT_ROUTER_CONFIG: "examples/config.yaml" }).code).toBe(0);
  });

  it("prints help and version, rejects unknown commands and flags", () => {
    expect(run(["-h"]).stdout).toContain("usage: alert-router");
    expect(run(["--version"]).stdout).toBe("alert-router dev\n");
    expect(run([])).toMatchObject({ code: 2 });
    expect(run(["deploy"]).stderr).toContain('unknown command "deploy"');
    expect(run(["--bogus"]).code).toBe(2);
  });
});

describe("isEntryPoint", () => {
  const self = new URL("../src/main.ts", import.meta.url).href;

  it("follows symlinks and rejects other files", () => {
    const file = fileURLToPath(self);
    const link = path.join(mkdtempSync(path.join(tmpdir(), "ar-")), "alert-router");
    symlinkSync(file, link);
    expect(isEntryPoint(link, self)).toBe(true);
    expect(isEntryPoint(undefined, self)).toBe(false);
    expect(isEntryPoint("/no/such/file", self)).toBe(false);
  });
});
