#!/usr/bin/env bash
# End-to-end: a real Alertmanager sends to the alert-router image, which posts
# to a mock Slack over HTTPS. Needs docker, node, openssl, curl and jq; uses the
# host network, so it is meant for a Linux CI runner.
set -euo pipefail

IMAGE=${IMAGE:-alert-router:e2e}
ALERTMANAGER_IMAGE=quay.io/prometheus/alertmanager:v0.34.1@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
chmod 755 "$work"

cleanup() {
  docker logs alert-router-e2e 2>&1 | sed 's/^/[alert-router] /' || true
  docker rm -f alert-router-e2e alertmanager-e2e >/dev/null 2>&1 || true
  [[ -n "${mock_pid:-}" ]] && kill "$mock_pid" 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url, what
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  echo "timed out waiting for $2" >&2
  return 1
}

messages() { [[ -f "$work/slack.jsonl" ]] && wc -l <"$work/slack.jsonl" | tr -d ' ' || echo 0; }

wait_messages() { # count
  for _ in $(seq 1 60); do (($(messages) >= $1)) && return 0; sleep 1; done
  echo "expected $1 Slack messages, got $(messages)" >&2
  cat "$work/slack.jsonl" >&2 || true
  return 1
}

post_alert() { # alertname severity namespace [endsAt]
  local ends=${4:-}
  jq -n --arg n "$1" --arg s "$2" --arg ns "$3" --arg e "$ends" \
    '[{labels: {alertname: $n, severity: $s, namespace: $ns}, annotations: {summary: "e2e \($n)"}} + (if $e == "" then {} else {endsAt: $e} end)]' |
    curl -fsS -X POST -H 'content-type: application/json' --data-binary @- http://localhost:9093/api/v2/alerts
}

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
chmod 644 "$work/key.pem" "$work/cert.pem"
token=$(openssl rand -hex 24)
printf '%s' "$token" >"$work/token"
chmod 644 "$work/token"

node "$here/mock-slack.mjs" "$work" "$work/slack.jsonl" 8443 &
mock_pid=$!

docker run -d --name alert-router-e2e --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v "$here/config.yaml:/etc/alert-router/config.yaml:ro" -v "$work/cert.pem:/certs/ca.pem:ro" \
  -e NODE_EXTRA_CA_CERTS=/certs/ca.pem -e ALERT_ROUTER_TOKEN="$token" \
  -e SLACK_PAGE=https://localhost:8443/page -e SLACK_TEAM=https://localhost:8443/team \
  "$IMAGE" >/dev/null
docker run -d --name alertmanager-e2e --network host \
  -v "$here/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" -v "$work/token:/etc/alertmanager/token:ro" \
  "$ALERTMANAGER_IMAGE" --config.file=/etc/alertmanager/alertmanager.yml >/dev/null

wait_for http://localhost:9095/healthz alert-router
wait_for http://localhost:9093/-/ready alertmanager

echo "--- requests without the token are refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' http://localhost:9095/webhook)
[[ "$code" == 401 ]] || { echo "want 401, got $code" >&2; exit 1; }

echo "--- firing: critical payments alert pages and reaches the team, a warning goes to the default"
post_alert PaymentsAPIDown critical payments-api
post_alert GrafanaReplicasMismatch warning monitoring
wait_messages 3
for path in /page /team; do
  jq -e --arg p "$path" 'select(.path == $p and (.body.text | test("FIRING 1: PaymentsAPIDown")))' "$work/slack.jsonl" >/dev/null
done
jq -e 'select(.path == "/team" and (.body.text | test("FIRING 1: GrafanaReplicasMismatch")))' "$work/slack.jsonl" >/dev/null
jq -e 'select(.body.text | test("PaymentsAPIDown")) | .body.blocks | tostring | test("runbooks.example.com/payments-api-down")' \
  "$work/slack.jsonl" >/dev/null

echo "--- resolved: the resolve is delivered to both receivers"
post_alert PaymentsAPIDown critical payments-api "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
wait_messages 5
[[ $(jq -s '[.[] | select(.body.text | test("RESOLVED 1: PaymentsAPIDown"))] | length' "$work/slack.jsonl") == 2 ]]

echo "--- metrics"
metrics=$(curl -fsS http://localhost:9095/metrics)
grep -q 'alert_router_notifications_total{receiver="page",result="sent"} 2' <<<"$metrics"
grep -q 'alert_router_notifications_total{receiver="team",result="sent"} 3' <<<"$metrics"
if grep -q 'result="failed"' <<<"$metrics"; then echo "unexpected failed deliveries" >&2; exit 1; fi

echo "e2e passed: $(messages) Slack messages"
