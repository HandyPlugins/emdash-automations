import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import { executeEvent } from "../src/engine.js";
import { withDeadline } from "../src/actions.js";
import type { Automation, NormalizedEvent, Run } from "../src/model.js";
const event: NormalizedEvent = { type: "content.published", data: {} };
const now = new Date().toISOString();
const a: Automation = { id: crypto.randomUUID(), name: "Email failure", enabled: true, trigger: { type: "content.published" }, triggerType: "content.published", actions: [{ type: "email", to: "owner@example.com", subject: "Hello", text: "Hello" }], createdAt: now, updatedAt: now, schemaVersion: 1 };
function context(email?: PluginContext["email"]) {
  const recorded: Run[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { site: { name: "Site", url: "https://site.example.com" }, email, log, storage: {
      automations: { query: async () => ({ items: [{ id: a.id, data: a }], hasMore: false }) },
      runs: { put: async (_id: string, run: Run) => { recorded.push(run); }, query: async () => ({ items: [], hasMore: false }) },
    } } as unknown as PluginContext;
  return { ctx, recorded, log };
}
describe("failure boundaries", () => {
  it("records unavailable and throwing email providers without exposing provider errors", async () => {
    const missing = context();
    await executeEvent(event, missing.ctx);
    expect(missing.recorded[0].status).toBe("failed");
    expect(missing.recorded[0].actions[0].error).toContain("Configure an EmDash email provider");
    const throwing = context({ send: async () => { throw new Error("SMTP secret password and recipient"); } });
    await expect(executeEvent(event, throwing.ctx)).resolves.toBeUndefined();
    expect(throwing.recorded[0].status).toBe("failed");
    expect(JSON.stringify(throwing.recorded)).not.toContain("SMTP secret");
  });
  it("contains storage query and history persistence failures", async () => {
    const c = context();
    c.ctx.storage.automations.query = async () => { throw new Error("Storage offline"); };
    await expect(executeEvent(event, c.ctx)).resolves.toBeUndefined();
    expect(c.log.error).toHaveBeenCalled();
    const d = context({ send: async () => { } });
    d.ctx.storage.runs.put = async () => { throw new Error("Disk full"); };
    await expect(executeEvent(event, d.ctx)).resolves.toBeUndefined();
    expect(d.log.error).toHaveBeenCalled();
  });
  it("bounds waiting for a stalled action", async () => {
    await expect(withDeadline(() => new Promise(() => { }), 10)).rejects.toThrow("Action timed out; delivery may still complete.");
  });
});
