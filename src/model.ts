import { z } from "zod";
export const SCHEMA_VERSION = 1;
export const MAX_AUTOMATIONS = 25;
export const RUN_RETENTION = 100;
export const triggerTypes = ["content.published", "content.saved", "media.uploaded"] as const;
export const tokens = ["site.name", "site.url", "event.type", "content.title", "content.id", "content.collection"] as const;
const tokenSet = new Set<string>(tokens);
const blockedHostSuffixes = ["nip.io", "sslip.io", "xip.io", "traefik.me", "lvh.me", "localtest.me", "metadata.google"];
export function validTemplate(value: string): boolean {
  const remainder = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, token: string) => tokenSet.has(token) ? "" : "{{invalid}}");
  return !remainder.includes("{{") && !remainder.includes("}}");
}
export function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // The host bridge separately checks destinations and redirect targets.
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      && (!url.port || url.port === "443") && host.includes(".")
      && !/^[\d.]+$/.test(host) && !host.includes(":") && !host.includes("[")
      && !blockedHostSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
      && !/(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host) && !host.endsWith(".");
  }
  catch {
    return false;
  }
}
const template = (max: number) => z.string().min(1).max(max).refine(validTemplate, "Use only the supported template tokens.");
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("webhook"), url: z.string().max(2048).refine(validWebhookUrl, "Enter a public HTTPS URL without credentials, a fragment, or a custom port.") }).strict(),
  z.object({ type: z.literal("email"), to: z.email().max(254), subject: template(200).refine(v => !/[\r\n]/.test(v), "Subject must be one line."), text: template(10000) }).strict(),
]);
export const AutomationSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  trigger: z.object({ type: z.enum(triggerTypes), collection: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional() }).strict()
    .refine(t => t.type !== "media.uploaded" || !t.collection, "Media triggers cannot filter content collections."),
  triggerType: z.enum(triggerTypes), actions: z.array(ActionSchema).min(1).max(5),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), schemaVersion: z.literal(SCHEMA_VERSION),
}).strict().refine(a => a.trigger.type === a.triggerType, "Trigger index must match the trigger.");
export type Automation = z.infer<typeof AutomationSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type TriggerType = typeof triggerTypes[number];
export interface NormalizedEvent {
  type: TriggerType;
  collection?: string;
  data: {
    content?: {
      id: string;
      title: string;
      collection: string;
      slug: string;
      status: string;
      isNew?: boolean;
    };
    media?: {
      id: string;
      filename: string;
      mimeType: string;
      size: number | null;
      url: string;
    };
  };
}
export interface ActionResult {
  type: Action["type"];
  status: "success" | "failed";
  error?: string;
  startedAt: string;
  finishedAt: string;
}
export interface Run {
  id: string;
  automationId: string;
  automationName: string;
  eventType: TriggerType;
  status: "success" | "failed" | "partial";
  actions: ActionResult[];
  startedAt: string;
  finishedAt: string;
  schemaVersion: 1;
}
export function interpolate(value: string, event: NormalizedEvent, site: {
  name: string;
  url: string;
}): string {
  const values: Record<string, string> = { "site.name": site.name, "site.url": site.url, "event.type": event.type,
    "content.title": event.data.content?.title ?? "", "content.id": event.data.content?.id ?? "", "content.collection": event.data.content?.collection ?? "" };
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, token: string) => values[token] ?? "");
}
