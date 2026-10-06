import type { PluginContext } from "emdash/plugin";
import { ActionFailure, actionRegistry, withDeadline } from "./actions.js";
import { AutomationSchema, MAX_AUTOMATIONS, RUN_RETENTION, type ActionResult, type NormalizedEvent, type Run } from "./model.js";
export async function pruneRuns(ctx: PluginContext): Promise<void> {
  const newest = await ctx.storage.runs.query({ orderBy: { startedAt: "desc" }, limit: RUN_RETENTION });
  let cursor = newest.hasMore ? newest.cursor : undefined;
  const ids: string[] = [];
  while (cursor) {
    const page = await ctx.storage.runs.query({ orderBy: { startedAt: "desc" }, limit: 100, cursor });
    ids.push(...page.items.map(row => row.id));
    cursor = page.hasMore ? page.cursor : undefined;
  }
  if (ids.length)
    await ctx.storage.runs.deleteMany(ids);
}
export async function executeEvent(event: NormalizedEvent, ctx: PluginContext): Promise<void> {
  // Leave room for storage within the runner's default 30s invocation.
  const deadline = Date.now() + 15000;
  try {
    const rows = await ctx.storage.automations.query({ where: { enabled: true, triggerType: event.type }, limit: MAX_AUTOMATIONS });
    for (const row of rows.items) {
      const parsed = AutomationSchema.safeParse(row.data);
      if (!parsed.success) {
        ctx.log.warn("Skipped invalid automation configuration.", { id: row.id });
        continue;
      }
      const automation = parsed.data;
      if (!automation.enabled || automation.trigger.type !== event.type || (automation.trigger.collection && automation.trigger.collection !== event.collection))
        continue;
      const startedAt = new Date().toISOString();
      const results: ActionResult[] = [];
      for (const action of automation.actions) {
        const actionStart = new Date().toISOString();
        let error: string | undefined;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new ActionFailure("Event execution budget exceeded; action was not started.");
          await withDeadline(() => actionRegistry[action.type].execute(action, automation, event, ctx), Math.min(3000, remaining));
        }
        catch (cause) {
          // Never store response bodies, addresses, URLs, credentials, or provider errors.
          error = cause instanceof ActionFailure ? cause.message : action.type === "email"
            ? "Email delivery failed. Check the site's email provider." : "Webhook request failed. Check the destination and network permissions.";
          ctx.log.warn("Automation action failed.", { automationId: automation.id, type: action.type, error });
        }
        results.push({ type: action.type, status: error ? "failed" : "success", ...(error ? { error } : {}), startedAt: actionStart, finishedAt: new Date().toISOString() });
      }
      const successes = results.filter(result => result.status === "success").length;
      const run: Run = { id: crypto.randomUUID(), automationId: automation.id, automationName: automation.name, eventType: event.type,
        status: successes === results.length ? "success" : successes === 0 ? "failed" : "partial", actions: results,
        startedAt, finishedAt: new Date().toISOString(), schemaVersion: 1 };
      try {
        await ctx.storage.runs.put(run.id, run);
      }
      catch {
        ctx.log.error("Could not store an automation execution result.", { automationId: automation.id });
      }
    }
    await pruneRuns(ctx);
  }
  catch {
    ctx.log.error("Automations could not process this event. CMS activity continues.");
  }
}
