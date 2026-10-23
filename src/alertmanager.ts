// Alertmanager webhook payload (version 4).
// https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
import { z } from "zod";

const labelSet = z.record(z.string(), z.string());

export const alertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: labelSet,
  annotations: labelSet.default({}),
  startsAt: z.string(),
  endsAt: z.string().default(""),
  generatorURL: z.string().default(""),
  fingerprint: z.string().min(1),
});

export const webhookSchema = z.object({
  version: z.literal("4"),
  groupKey: z.string(),
  truncatedAlerts: z.number().int().nonnegative().default(0),
  status: z.enum(["firing", "resolved"]),
  receiver: z.string(),
  groupLabels: labelSet.default({}),
  commonLabels: labelSet.default({}),
  commonAnnotations: labelSet.default({}),
  externalURL: z.string().default(""),
  alerts: z.array(alertSchema).max(1000),
});

export type Alert = z.infer<typeof alertSchema>;
export type Webhook = z.infer<typeof webhookSchema>;
