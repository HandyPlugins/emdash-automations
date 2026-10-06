import { expect, it } from "vitest";
import { createPluginTestHost } from "@emdash-cms/plugin-test";
import type { Run } from "../src/model.js";
it("records a missing host email transport through the real sandbox bridge", async () => {
  // The transport-only official host deliberately has no runtime email provider.
  const host = await createPluginTestHost();
  try {
    const response = await host.invokeRoute("admin", {
      type: "form_submit", action_id: "save", block_id: "new",
      values: { name: "Missing provider", enabled: true, trigger: "content.published", action: "email", to: "owner@example.com", subject: "Published", text: "Hello" },
    }, { user: { id: "admin", email: "admin@example.com", name: null, role: 50, createdAt: new Date().toISOString() } });
    expect(response).toMatchObject({ toast: { type: "success" } });
    await expect(host.invokeHook("content:afterPublish", { collection: "posts", content: { id: "post-1", data: { title: "Post" } } })).resolves.toBeUndefined();
    const rows = await host.storage<Run>("runs").list();
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ status: "failed", actions: [{ type: "email", status: "failed", error: "Email delivery failed. Check the site's email provider." }] });
  }
  finally {
    await host.dispose();
  }
});
