import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { Automation, Run, TriggerType } from "../src/model.js";
let host: PluginRuntimeTestHost;
afterEach(async () => { await host?.dispose(); });
const url = "https://hooks.example.com/events";
const event = { content: { id: "entry-1", slug: "hello", status: "published", data: { title: "Hello", privateKey: "NEVER FORWARD" } }, collection: "posts" };
const email = { type: "email" as const, to: "owner@example.com", subject: "{{content.title}} on {{site.name}}", text: "{{event.type}}: {{content.id}} / {{content.collection}} / {{site.url}}" };
function automation(overrides: Partial<Automation> = {}): Automation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: "Publish notification", enabled: true, trigger: { type: "content.published" }, triggerType: "content.published", actions: [{ type: "webhook", url }], createdAt: now, updatedAt: now, schemaVersion: 1, ...overrides };
}
async function seed(a: Automation) { await host.fixtures.plugin.storage("automations", a.id, a); }
async function setup() {
  host = await createPluginRuntimeTestHost({ site: { name: "Test site", url: "https://site.example.com" } });
  await host.fixtures.collection({ slug: "posts", label: "Posts", fields: [{ slug: "title", label: "Title", type: "string" }] });
  await host.fixtures.collection({ slug: "pages", label: "Pages", fields: [{ slug: "title", label: "Title", type: "string" }] });
}
const runs = async () => (await host.inspect.storage.list<Run>("runs")).map(row => row.data);
describe("production sandbox and runtime", () => {
  it("posts an event-specific safe JSON payload for an enabled matching automation", async () => {
    await setup();
    const a = automation();
    await seed(a);
    await host.http.respond(url, new Response(null, { status: 204 }));
    await host.transport.invokeHook("content:afterPublish", event);
    const request = host.http.requests()[0];
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    const payload = JSON.parse(new TextDecoder().decode(request.body));
    expect(payload).toMatchObject({ automation: { id: a.id, name: a.name }, event: { type: "content.published" }, site: { name: "Test site", url: "https://site.example.com" }, data: { content: { id: "entry-1", title: "Hello", collection: "posts", status: "published" } } });
    expect(payload.event.timestamp).toMatch(/^\d{4}-/);
    expect(JSON.stringify(payload)).not.toContain("NEVER FORWARD");
    expect(await runs()).toMatchObject([{ status: "success", schemaVersion: 1, actions: [{ type: "webhook", status: "success" }] }]);
    expect(JSON.stringify(await runs())).not.toContain(url);
  });
  it("skips disabled automations, other triggers, other collections, and malformed storage", async () => {
    await setup();
    await seed(automation({ enabled: false }));
    await seed(automation({ trigger: { type: "content.saved" }, triggerType: "content.saved" }));
    await seed(automation({ trigger: { type: "content.published", collection: "pages" } }));
    const invalid = automation();
    await host.fixtures.plugin.storage("automations", invalid.id, { ...invalid, actions: [{ type: "unknown" }] });
    await host.transport.invokeHook("content:afterPublish", event);
    expect(host.http.requests()).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });
  it("contains HTTP and network failures and continues sequential actions with partial status", async () => {
    await setup();
    const secondUrl = "https://hooks.example.com/second";
    await seed(automation({ actions: [{ type: "webhook", url }, { type: "webhook", url: secondUrl }, email] }));
    await host.http.respond(url, new Response("secret response", { status: 503 }));
    await host.http.respond(secondUrl, new Response(null, { status: 204 }));
    await expect(host.transport.invokeHook("content:afterPublish", event)).resolves.toBeUndefined();
    expect(host.http.requests().map(r => r.url)).toEqual([url, secondUrl]);
    const result = (await runs())[0];
    expect(result.status).toBe("partial");
    expect(result.actions.map(a => a.status)).toEqual(["failed", "success", "success"]);
    expect(result.actions[0].error).toBe("Webhook returned HTTP 503.");
    expect(JSON.stringify(result)).not.toContain("secret response");
    expect(await host.inspect.email()).toMatchObject([{ to: "owner@example.com", subject: "Hello on Test site", text: "content.published: entry-1 / posts / https://site.example.com" }]);
    // No fixture response: the official mock transport fails without using the network.
    await seed(automation({ name: "Network failure", trigger: { type: "content.saved" }, triggerType: "content.saved" }));
    await host.transport.invokeHook("content:afterSave", { ...event, isNew: false });
    expect((await runs()).find(r => r.eventType === "content.saved")?.status).toBe("failed");
  });
  it("fires real create/update/publish hooks and preserves CMS publishing despite failures", async () => {
    await setup();
    await seed(automation({ trigger: { type: "content.saved", collection: "posts" }, triggerType: "content.saved", actions: [email] }));
    await seed(automation());
    const created = await host.actions.content.create("posts", { slug: "runtime-post", data: { title: "Runtime post" }, status: "draft" });
    expect(created.success).toBe(true);
    if (!created.success)
      throw new Error("Create failed");
    const id = created.data.item.id;
    await expect.poll(async () => (await runs()).filter(r => r.eventType === "content.saved").length).toBe(1);
    const updated = await host.actions.content.update("posts", id, { data: { title: "Updated post" } });
    expect(updated.success).toBe(true);
    await expect.poll(async () => (await runs()).filter(r => r.eventType === "content.saved").length).toBe(2);
    await host.http.respond(url, new Response(null, { status: 502 }));
    expect((await host.actions.content.publish("posts", id)).success).toBe(true);
    await expect.poll(async () => (await runs()).filter(r => r.eventType === "content.published").length).toBe(1);
    expect((await host.inspect.content.get("posts", id))?.status).toBe("published");
    const log = await runs();
    expect(log.filter(r => r.eventType === "content.saved")).toHaveLength(2);
    expect(log.find(r => r.eventType === "content.published")?.status).toBe("failed");
    expect((await host.inspect.email()).map(m => m.subject)).toEqual(["Runtime post on Test site", "Updated post on Test site"]);
  });
  it("fires the real media upload hook and forwards media metadata with empty content tokens", async () => {
    await setup();
    await seed(automation({ trigger: { type: "media.uploaded" }, triggerType: "media.uploaded", actions: [{ type: "webhook", url }, { ...email, subject: "Upload on {{site.name}}" }] }));
    await host.http.respond(url, new Response(null, { status: 204 }));
    const uploaded = await host.actions.media.upload({ filename: "sample.png", contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=" });
    expect(uploaded.success).toBe(true);
    await expect.poll(async () => (await runs()).length).toBe(1);
    const payload = JSON.parse(new TextDecoder().decode(host.http.requests()[0].body));
    expect(payload).toMatchObject({ event: { type: "media.uploaded" }, data: { media: { filename: "sample.png", mimeType: "image/png" } } });
    expect(payload.data.content).toBeUndefined();
    expect(await host.inspect.email()).toMatchObject([{ text: "media.uploaded:  /  / https://site.example.com" }]);
  });
  it("supports admin CRUD, collection discovery, stale-edit protection, and retained history", async () => {
    await setup();
    expect(JSON.stringify(await host.admin.loadPage("/manage"))).toContain("No automations yet");
    const editor = await host.admin.act("/manage", "create");
    expect(JSON.stringify(editor)).toContain('"label":"Posts"');
    const values = { name: "UI automation", enabled: true, trigger: "content.published", collection: "posts", action: "webhook", url };
    expect((await host.admin.submit("/manage", "save", values, { blockId: "new" })).toast?.type).toBe("success");
    let a = (await host.inspect.storage.list<Automation>("automations"))[0].data;
    const edit = await host.admin.act("/manage", "edit", { value: a.id });
    const form = edit.blocks.find(b => b.type === "form");
    expect((await host.admin.submit("/manage", "save", { ...values, name: "Renamed" }, { blockId: form?.block_id })).toast?.type).toBe("success");
    expect((await host.admin.submit("/manage", "save", values, { blockId: form?.block_id })).toast?.type).toBe("error");
    a = (await host.inspect.storage.get<Automation>("automations", a.id))!;
    expect(a.name).toBe("Renamed");
    await host.http.respond(url, new Response(null, { status: 204 }));
    await host.transport.invokeHook("content:afterPublish", event);
    expect(JSON.stringify(await host.admin.act("/manage", "history", { value: a.id }))).toContain("success");
    await host.admin.act("/manage", "toggle", { value: a.id });
    await host.transport.invokeHook("content:afterPublish", event);
    expect(await runs()).toHaveLength(1);
    expect(host.http.requests()).toHaveLength(1);
    await host.admin.act("/manage", "toggle", { value: a.id });
    expect((await host.inspect.storage.get<Automation>("automations", a.id))?.enabled).toBe(true);
    await host.admin.act("/manage", "delete", { value: a.id });
    expect(await host.inspect.storage.get("automations", a.id)).toBeNull();
    expect(await runs()).toHaveLength(1);
    await host.restart();
    expect(await runs()).toHaveLength(1);
  });
  it("rejects malformed inputs, unsafe URLs, unknown templates, and non-admin mutations", async () => {
    await setup();
    const base = { name: "Invalid", enabled: true, trigger: "content.published", action: "webhook" };
    for (const badUrl of ["http://hooks.example.com", "https://127.0.0.1/", "https://localhost/", "https://[::1]/", "https://127.0.0.1.nip.io/", "https://metadata.google/", "https://user:password@hooks.example.com/", "https://hooks.example.com:444/", "https://hooks.example.com/#fragment"]) {
      expect((await host.admin.submit("/manage", "save", { ...base, url: badUrl }, { blockId: "new" })).toast?.type).toBe("error");
    }
    expect((await host.admin.submit("/manage", "save", { ...base, trigger: "invalid", url }, { blockId: "new" })).toast?.type).toBe("error");
    expect((await host.admin.submit("/manage", "save", { ...base, collection: "missing", url }, { blockId: "new" })).toast?.type).toBe("error");
    expect((await host.admin.submit("/manage", "save", { ...base, action: "email", to: "owner@example.com", subject: "{{content.secret}}", text: "Hello" }, { blockId: "new" })).toast?.type).toBe("error");
    const user = await host.fixtures.user({ email: "editor@example.com", role: "editor" });
    await expect(host.admin.submit("/manage", "save", { ...base, url }, { blockId: "new", user })).rejects.toThrow("403");
    expect(await host.inspect.storage.list("automations")).toHaveLength(0);
    const malformed = await host.transport.invokeRoute("admin", { type: "form_submit", values: null }, { user: { id: "admin", email: "admin@example.com", name: null, role: 50, createdAt: new Date().toISOString() } });
    expect(malformed).toMatchObject({ toast: { type: "error" } });
    const anonymous = await host.actions.routes.request("admin", { method: "POST", body: { type: "page_load", page: "/manage" } });
    expect(anonymous.status).toBe(401);
  });
  it("retains the newest 100 runs and does not destructively edit multiple actions", async () => {
    await setup();
    const a = automation({ actions: [email, email] });
    await seed(a);
    expect((await host.admin.act("/manage", "edit", { value: a.id })).toast?.type).toBe("error");
    for (let i = 0; i < 103; i++) {
      const id = crypto.randomUUID();
      const time = new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString();
      await host.fixtures.plugin.storage("runs", id, { id, automationId: a.id, automationName: a.name, eventType: "content.published" satisfies TriggerType, status: "success", actions: [], startedAt: time, finishedAt: time, schemaVersion: 1 });
    }
    await host.transport.invokeHook("content:afterPublish", event);
    const result = await runs();
    expect(result).toHaveLength(100);
    expect(result.filter(r => r.startedAt.startsWith("2025"))).toHaveLength(99);
    expect(result.some(r => r.startedAt === "2025-01-01T00:00:00.000Z")).toBe(false);
    expect((await host.inspect.storage.get<Automation>("automations", a.id))?.actions).toHaveLength(2);
  });
  it("does not follow redirects or forward an event to another destination", async () => {
    await setup();
    await seed(automation());
    await host.http.respond(url, new Response(null, { status: 307, headers: { Location: "http://127.0.0.1/private" } }));
    await host.transport.invokeHook("content:afterPublish", event);
    expect(host.http.requests()).toHaveLength(1);
    expect((await runs())[0].status).toBe("failed");
  });
  it("continues with other matching automations after one fails", async () => {
    await setup();
    await seed(automation());
    await seed(automation({ name: "Second match", actions: [email] }));
    await host.http.respond(url, new Response(null, { status: 500 }));
    await host.transport.invokeHook("content:afterPublish", event);
    expect(await runs()).toHaveLength(2);
    expect((await runs()).map(r => r.status).sort()).toEqual(["failed", "success"]);
    expect(await host.inspect.email()).toHaveLength(1);
  });
  it("declares exactly the APIs used and stays sandboxed", async () => {
    await setup();
    expect([...host.manifest.capabilities].sort()).toEqual(["content:read", "media:read", "schema:read", "network:request:unrestricted", "network:request", "email:send"].sort());
    expect(host.manifest.allowedHosts).toEqual([]);
    expect(Object.keys(host.manifest.storage)).toEqual(["automations", "runs"]);
    const route = host.manifest.routes?.find(r => typeof r !== "string" && r.name === "admin");
    expect(route).toBeDefined();
    if (typeof route === "object")
      expect(route.public).not.toBe(true);
  });
});
