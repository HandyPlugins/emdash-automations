import type { PluginContext } from "emdash/plugin";
import { ActionSchema, interpolate, type Action, type Automation, type NormalizedEvent } from "./model.js";
export class ActionFailure extends Error {
}
type ActionHandler = (action: Action, automation: Automation, event: NormalizedEvent, ctx: PluginContext) => Promise<void>;
export const actionRegistry: Record<Action["type"], {
  label: string;
  execute: ActionHandler;
}> = {
  webhook: { label: "Send webhook", execute: async (action, automation, event, ctx) => {
      if (action.type !== "webhook" || !ctx.http)
        throw new ActionFailure("Webhook service unavailable.");
      const response = await ctx.http.fetch(action.url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automation: { id: automation.id, name: automation.name }, event: { type: event.type, timestamp: new Date().toISOString() }, site: { name: ctx.site.name, url: ctx.site.url }, data: event.data }) });
      if (!response.ok)
        throw new ActionFailure(`Webhook returned HTTP ${response.status}.`);
    } },
  email: { label: "Send email", execute: async (action, _automation, event, ctx) => {
      if (action.type !== "email" || !ctx.email)
        throw new ActionFailure("Email service unavailable. Configure an EmDash email provider.");
      const message = { ...action, subject: interpolate(action.subject, event, ctx.site), text: interpolate(action.text, event, ctx.site) };
      if (!ActionSchema.safeParse(message).success)
        throw new ActionFailure("Interpolated email exceeds limits or has an invalid subject.");
      await ctx.email.send({ to: message.to, subject: message.subject, text: message.text });
    } },
};
// The bridge does not serialize AbortSignal: this bounds waiting, not delivery.
export async function withDeadline<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ActionFailure("Action timed out; delivery may still complete.")), timeoutMs);
      })]);
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
