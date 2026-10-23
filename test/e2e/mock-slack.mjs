// HTTPS stand-in for Slack incoming webhooks: records every POST body as a JSON line.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import process from "node:process";

const [certDir, outFile, port = "8443"] = process.argv.slice(2);
const server = createServer(
  { key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) },
  (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      appendFileSync(outFile, JSON.stringify({ path: req.url, body: JSON.parse(body) }) + "\n");
      res.writeHead(200).end("ok");
    });
  },
);
server.listen(Number(port), () => process.stdout.write(`mock slack on :${port}\n`));
