import type { ContentHookEvent, ContentStateChangeEvent, MediaAfterUploadEvent } from "emdash/plugin";
import type { NormalizedEvent, TriggerType } from "./model.js";
const string = (value: unknown, max = 4096): string => typeof value === "string" ? value.slice(0, max) : "";
function contentEvent(type: TriggerType, event: ContentStateChangeEvent | ContentHookEvent): NormalizedEvent {
  const data = event.content.data;
  const fields = data && typeof data === "object" ? data as Record<string, unknown> : event.content;
  return { type, collection: event.collection, data: { content: {
        id: string(event.content.id, 128), title: string(fields.title), collection: event.collection,
        slug: string(event.content.slug, 256), status: string(event.content.status, 32), ...("isNew" in event ? { isNew: event.isNew } : {}),
      } } };
}
// Extend these normalizers and the model union when adding a trigger.
export const triggerRegistry = {
  "content.published": { label: "Content published", normalize: (e: ContentStateChangeEvent) => contentEvent("content.published", e) },
  "content.saved": { label: "Content saved / updated", normalize: (e: ContentHookEvent) => contentEvent("content.saved", e) },
  "media.uploaded": { label: "Media uploaded", normalize: (e: MediaAfterUploadEvent): NormalizedEvent => ({ type: "media.uploaded", data: { media: {
          id: string(e.media.id, 128), filename: string(e.media.filename, 1024), mimeType: string(e.media.mimeType, 128), size: e.media.size, url: string(e.media.url, 2048),
        } } }) },
};
