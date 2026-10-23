import { describe, expect, it } from "vitest";
import { routeAlert } from "../src/route.js";
import { exampleConfig } from "./helpers.js";

const config = exampleConfig();

describe("routeAlert", () => {
  it.each([
    [{ severity: "critical", namespace: "payments-api" }, ["platform-page", "payments"]],
    [{ severity: "critical", namespace: "kube-system" }, ["platform-page", "platform"]],
    [{ severity: "warning", namespace: "payments" }, ["payments"]],
    [{ severity: "warning", namespace: "monitoring" }, ["platform"]],
    [{ severity: "warning", namespace: "team-x" }, ["catch-all"]],
    [{ severity: "critical", namespace: "team-x" }, ["platform-page"]],
    [{ severity: "warning" }, ["catch-all"]],
  ])("%j -> %j", (labels, want) => {
    expect(routeAlert(config, labels)).toEqual(want);
  });

  it("does not partially match a regex", () => {
    expect(routeAlert(config, { namespace: "not-payments" })).toEqual(["catch-all"]);
  });

  it("treats a missing label as empty for match_re", () => {
    const c = {
      ...config,
      routes: [{ receiver: "platform", match: {}, matchRe: { team: /^(?:)$/ }, continue: false }],
    };
    expect(routeAlert(c, {})).toEqual(["platform"]);
    expect(routeAlert(c, { team: "x" })).toEqual(["catch-all"]);
  });

  it("lists a receiver once even if several continuing routes pick it", () => {
    const route = { receiver: "platform", match: {}, matchRe: {}, continue: true };
    expect(routeAlert({ ...config, routes: [route, route] }, {})).toEqual(["platform"]);
  });
});
