import type { SlackMessage } from "./slack.js";

export type Send = (url: URL, message: SlackMessage) => Promise<void>;

export interface SenderOptions {
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const maxRetryAfterMs = 30_000;

/** Posts to a Slack incoming webhook, retrying on 429 and 5xx. */
export function slackSender(opt: SenderOptions = {}): Send {
  const doFetch = opt.fetch ?? fetch;
  const retries = opt.retries ?? 3;
  const sleep = opt.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (url, message) => {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(opt.timeoutMs ?? 10_000),
        // A webhook URL never needs to redirect; refusing keeps the payload on the allowed host.
        redirect: "error",
      });
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        // The URL contains the webhook secret, so only the host goes into the error.
        throw new Error(`POST ${url.host}: HTTP ${String(res.status)}`);
      }
      const after = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(after) && after > 0 ? Math.min(after * 1000, maxRetryAfterMs) : 500 * 2 ** attempt,
      );
    }
  };
}
