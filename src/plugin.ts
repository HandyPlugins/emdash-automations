import type { SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./admin.js";
import { executeEvent } from "./engine.js";
import { triggerRegistry } from "./triggers.js";
/**
* Sandboxed plugin entry. The explicit `SandboxedPlugin` annotation gives TypeScript per-hook /
* per-route inference (`ctx` is `PluginContext` automatically; hook
* `event` parameters are typed by hook name).
*/
const plugin: SandboxedPlugin = {
  hooks: {
    "content:afterPublish": async (event, ctx) => { try {
      await executeEvent(triggerRegistry["content.published"].normalize(event), ctx);
    }
    catch {
      ctx.log.error("Automations could not normalize the publish event.");
    } },
    "content:afterSave": async (event, ctx) => { try {
      await executeEvent(triggerRegistry["content.saved"].normalize(event), ctx);
    }
    catch {
      ctx.log.error("Automations could not normalize the save event.");
    } },
    "media:afterUpload": async (event, ctx) => { try {
      await executeEvent(triggerRegistry["media.uploaded"].normalize(event), ctx);
    }
    catch {
      ctx.log.error("Automations could not normalize the upload event.");
    } },
  },
  routes: {
    admin: { methods: ["POST"], handler: handleAdmin },
  },
};
export default plugin;
