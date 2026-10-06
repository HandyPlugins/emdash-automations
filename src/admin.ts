import { z } from "zod";
import type { BlockResponse, ButtonElement, FormField } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { ActionSchema, AutomationSchema, MAX_AUTOMATIONS, tokens, triggerTypes, type Automation, type Run } from "./model.js";
import { triggerRegistry } from "./triggers.js";
import { actionRegistry } from "./actions.js";
const interactionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_load"), page: z.string().max(200) }),
  z.object({ type: z.literal("block_action"), action_id: z.string().max(100), value: z.unknown().optional(), block_id: z.string().max(200).optional(), page: z.string().optional() }),
  z.object({ type: z.literal("form_submit"), action_id: z.literal("save"), block_id: z.string().max(200).optional(), values: z.record(z.string(), z.unknown()), page: z.string().optional() }),
]);
const formSchema = z.object({
  name: z.string().trim().min(1).max(100), enabled: z.boolean(), trigger: z.enum(triggerTypes),
  collection: z.string().max(64).optional().default(""), action: z.enum(["webhook", "email"]),
  url: z.string().max(2048).optional(), to: z.string().max(254).optional(), subject: z.string().max(200).optional(), text: z.string().max(10000).optional(),
}).strict();
const button = (action_id: string, label: string, value?: string): ButtonElement => ({ type: "button", action_id, label, ...(value ? { value } : {}) });
const errorResponse = (message: string): BlockResponse => ({ blocks: [{ type: "header", text: "Automations" }, { type: "section", text: message }, { type: "actions", elements: [button("list", "Back to automations")] }], toast: { type: "error", message } });
async function list(ctx: PluginContext): Promise<BlockResponse> {
  const rows = await ctx.storage.automations.query({ orderBy: { updatedAt: "desc" }, limit: 100 });
  const recent = await ctx.storage.runs.query({ orderBy: { startedAt: "desc" }, limit: 100 });
  const lastRuns = new Map<string, string>();
  for (const row of recent.items) {
    const run = row.data as Partial<Run> | null;
    if (run?.schemaVersion === 1 && typeof run.automationId === "string" && typeof run.status === "string" && !lastRuns.has(run.automationId))
      lastRuns.set(run.automationId, run.status);
  }
  return { blocks: [
      { type: "header", text: "Automations" },
      { type: "section", text: "Run actions when content is published, saved, or media is uploaded." },
      { type: "actions", elements: [button("create", "Create automation"), button("history", "Execution history")] },
      { type: "table", page_action_id: "list", empty_text: "No automations yet. Create your first automation.",
        columns: [{ key: "name", label: "Name" }, { key: "trigger", label: "Trigger" }, { key: "collection", label: "Collection" }, { key: "enabled", label: "Status", format: "badge" }, { key: "lastRun", label: "Last run", format: "badge" }, { key: "edit", label: "Edit", format: "element" }, { key: "toggle", label: "Enable / disable", format: "element" }, { key: "history", label: "History", format: "element" }, { key: "remove", label: "Delete", format: "element" }],
        rows: rows.items.map(row => {
          const parsed = AutomationSchema.safeParse(row.data);
          const a = parsed.success ? parsed.data : undefined;
          return { name: a?.name ?? "Invalid configuration", trigger: a ? triggerRegistry[a.trigger.type].label : "Unsupported schema", collection: a?.trigger.collection ?? "All", enabled: a?.enabled ? "Enabled" : "Disabled", lastRun: lastRuns.get(row.id) ?? "—",
            ...(a ? { edit: button("edit", "Edit", row.id), toggle: button("toggle", a.enabled ? "Disable" : "Enable", row.id), history: button("history", "View runs", row.id) } : {}),
            remove: { ...button("delete", "Delete", row.id), style: "danger", confirm: { title: "Delete automation?", text: "This removes the automation. Recent execution history is retained.", confirm: "Delete", deny: "Cancel", style: "danger" } } };
        }) },
    ] };
}
async function editor(ctx: PluginContext, automation?: Automation): Promise<BlockResponse> {
  if (automation && automation.actions.length !== 1)
    return errorResponse("This editor supports one action. Multi-action configurations are preserved and cannot be edited here.");
  const collections = await ctx.schema?.listCollections() ?? [];
  const action = automation?.actions[0];
  const fields: FormField[] = [
    { type: "text_input", action_id: "name", label: "Name", initial_value: automation?.name ?? "" },
    { type: "toggle", action_id: "enabled", label: "Enabled", initial_value: automation?.enabled ?? true },
    { type: "select", action_id: "trigger", label: "Trigger", options: triggerTypes.map(type => ({ label: triggerRegistry[type].label, value: type })), initial_value: automation?.trigger.type ?? "content.published" },
    { type: "select", action_id: "collection", label: "Content collection (optional)", options: [{ label: "All collections", value: "" }, ...collections.map(c => ({ label: c.label, value: c.slug }))], initial_value: automation?.trigger.collection ?? "", condition: { field: "trigger", neq: "media.uploaded" } },
    { type: "select", action_id: "action", label: "Action", options: Object.entries(actionRegistry).map(([value, a]) => ({ label: a.label, value })), initial_value: action?.type ?? "webhook" },
    { type: "text_input", action_id: "url", label: "Webhook URL (public HTTPS)", initial_value: action?.type === "webhook" ? action.url : "", placeholder: "https://your-service.com/events", condition: { field: "action", eq: "webhook" } },
    { type: "text_input", action_id: "to", label: "Email recipient", initial_value: action?.type === "email" ? action.to : "", condition: { field: "action", eq: "email" } },
    { type: "text_input", action_id: "subject", label: "Email subject", initial_value: action?.type === "email" ? action.subject : "Published: {{content.title}}", condition: { field: "action", eq: "email" } },
    { type: "text_input", action_id: "text", label: "Email message (plain text)", multiline: true, initial_value: action?.type === "email" ? action.text : "{{content.title}} was published on {{site.name}}.", condition: { field: "action", eq: "email" } },
  ];
  return { blocks: [{ type: "header", text: automation ? "Edit automation" : "Create automation" },
      { type: "form", block_id: automation ? `${automation.id}:${automation.updatedAt}` : "new", fields, submit: { label: "Save automation", action_id: "save" } },
      { type: "context", text: `Email tokens: ${tokens.map(t => `{{${t}}}`).join(", ")}. Content tokens are empty for media events. Email uses the site's provider; local development may only log messages.` },
      { type: "actions", elements: [button("list", "Cancel")] }] };
}
async function history(ctx: PluginContext, automationId?: string): Promise<BlockResponse> {
  const rows = await ctx.storage.runs.query({ ...(automationId ? { where: { automationId } } : {}), orderBy: { startedAt: "desc" }, limit: 100 });
  return { blocks: [{ type: "header", text: "Execution history" }, { type: "context", text: "The latest 100 runs are retained across all automations. Requests and email content are not stored." },
      { type: "actions", elements: [button("list", "Back to automations"), button("history", "Refresh", automationId)] },
      { type: "table", page_action_id: "history", empty_text: "No executions recorded yet.", columns: [
          { key: "name", label: "Automation" }, { key: "event", label: "Event" }, { key: "status", label: "Status", format: "badge" }, { key: "startedAt", label: "Started", format: "relative_time" }, { key: "finishedAt", label: "Finished", format: "relative_time" }, { key: "actions", label: "Action results" },
        ], rows: rows.items.flatMap(row => {
          const run = row.data as Partial<Run> | null;
          if (!run || run.schemaVersion !== 1 || !Array.isArray(run.actions))
            return [];
          return [{ name: run.automationName, event: run.eventType, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
              actions: run.actions.map((a, i) => `${i + 1}. ${a.type}: ${a.status}${a.error ? ` — ${a.error}` : ""}`).join("; ") }];
        }) }] };
}
export async function handleAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  // Private host routes enforce authentication/CSRF; editing destinations requires admin.
  if (!route.user || route.user.role < 50)
    return errorResponse("Only site administrators can manage automations.");
  const parsed = interactionSchema.safeParse(route.input);
  if (!parsed.success)
    return errorResponse("Invalid admin request.");
  const input = parsed.data;
  try {
    if (input.type === "page_load")
      return await list(ctx);
    if (input.type === "form_submit") {
      const form = formSchema.safeParse(input.values);
      if (!form.success)
        return errorResponse("Please enter a name and valid trigger/action fields.");
      const f = form.data;
      const id = input.block_id === "new" ? crypto.randomUUID() : input.block_id?.slice(0, 36);
      if (!id || !z.uuid().safeParse(id).success)
        return errorResponse("Invalid automation ID.");
      const existing = await ctx.storage.automations.getVersioned(id);
      const old = existing ? AutomationSchema.parse(existing.value) : undefined;
      if (input.block_id !== "new" && !old)
        return errorResponse("Automation no longer exists.");
      if (old && (old.actions.length !== 1 || input.block_id !== `${old.id}:${old.updatedAt}`))
        return errorResponse("The automation changed. Reopen it before saving.");
      if (!old && await ctx.storage.automations.count() >= MAX_AUTOMATIONS)
        return errorResponse(`This version supports up to ${MAX_AUTOMATIONS} automations.`);
      if (f.trigger !== "media.uploaded" && f.collection) {
        const collections = await ctx.schema?.listCollections() ?? [];
        if (!collections.some(c => c.slug === f.collection))
          return errorResponse("Select an existing content collection.");
      }
      const action = ActionSchema.safeParse(f.action === "webhook" ? { type: "webhook", url: f.url } : { type: "email", to: f.to, subject: f.subject, text: f.text });
      if (!action.success)
        return errorResponse(action.error.issues[0]?.message ?? "Invalid action configuration.");
      const now = new Date().toISOString();
      const automation = AutomationSchema.parse({ id, name: f.name, enabled: f.enabled, trigger: { type: f.trigger, ...(f.trigger !== "media.uploaded" && f.collection ? { collection: f.collection } : {}) }, triggerType: f.trigger, actions: [action.data], createdAt: old?.createdAt ?? now, updatedAt: now, schemaVersion: 1 });
      const saved = await ctx.storage.automations.compareAndSet(id, existing?.revision ?? null, automation);
      if (!saved.applied)
        return errorResponse("The automation changed. Reopen it before saving.");
      return { ...await list(ctx), toast: { type: "success", message: "Automation saved." } };
    }
    if (input.action_id === "list")
      return await list(ctx);
    if (input.action_id === "create")
      return await editor(ctx);
    if (input.action_id === "history") {
      if (input.value !== undefined && !z.uuid().safeParse(input.value).success)
        return errorResponse("Invalid automation ID.");
      return await history(ctx, input.value as string | undefined);
    }
    const id = z.uuid().safeParse(input.value);
    if (!id.success)
      return errorResponse("Invalid automation ID.");
    const existing = await ctx.storage.automations.getVersioned(id.data);
    if (!existing)
      return errorResponse("Automation no longer exists.");
    if (input.action_id === "delete") {
      const deleted = await ctx.storage.automations.compareAndDelete(id.data, existing.revision);
      if (!deleted.applied)
        return errorResponse("The automation changed. Try again.");
      return { ...await list(ctx), toast: { type: "success", message: "Automation deleted." } };
    }
    const automation = AutomationSchema.parse(existing.value);
    if (input.action_id === "edit")
      return await editor(ctx, automation);
    if (input.action_id === "toggle") {
      const result = await ctx.storage.automations.compareAndSet(id.data, existing.revision, { ...automation, enabled: !automation.enabled, updatedAt: new Date().toISOString() });
      if (!result.applied)
        return errorResponse("The automation changed. Try again.");
      return { ...await list(ctx), toast: { type: "success", message: automation.enabled ? "Automation disabled." : "Automation enabled." } };
    }
    return errorResponse("Unknown admin action.");
  }
  catch {
    return errorResponse("Could not complete this request. Check storage and reopen Automations.");
  }
}
