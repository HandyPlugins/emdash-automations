# Automations

**Automate your EmDash site with triggers and actions.**

A sandboxed EmDash plugin with a Block Kit admin page for creating, editing,
enabling/disabling, deleting automations and inspecting recent execution history.
Version 0.1.0 is an unpublished development candidate from
[HandyPlugins](https://handyplugins.co). The selected publisher account is
`handyplugins.co`, pinned to DID `did:plc:6kdx7jauswq2awrp3yfxbbw5`.
Security reports can be sent to `support@handyplugins.co`.

## Supported behavior

| When | Then |
| --- | --- |
| Content published | Send a JSON POST webhook or plain-text email |
| Content saved / updated, including new drafts | Send a JSON POST webhook or plain-text email |
| Media uploaded | Send a JSON POST webhook or plain-text email |

Content triggers optionally filter by collection. Choices come from the official
schema API. The editor creates one action; the internal model supports up to five
sequential actions. It refuses to overwrite multi-action definitions.

Email subject/body accept only these tokens:
`{{site.name}}`, `{{site.url}}`, `{{event.type}}`, `{{content.title}}`,
`{{content.id}}`, `{{content.collection}}`. No expressions or code run. Content
tokens are empty for media events. Recipient and webhook URL are fixed values.

Webhook payloads contain `automation: {id, name}`, `event: {type, timestamp}`,
`site: {name, url}` and `data`. The allowlisted projection uses actual hook data:
content ID/title/collection/slug/status (plus `isNew` on saves), or media
ID/filename/MIME type/size/URL. It excludes arbitrary fields, bodies and actors.
Custom headers are intentionally omitted.

Webhook destinations must use HTTPS, DNS names and port 443, without URL
credentials or fragments. Known internal names, IP literals and common wildcard
DNS services are rejected. Redirects are rejected rather than forwarding event
data. The official network bridge adds its own host/security checks; this is
not a DNS-pinning guarantee. Configure trusted destinations.

Email uses `ctx.email.send({to, subject, text})`. A missing or failing provider
produces a failed run without rejecting CMS activity. EmDash 1.1 development
mode can use a console provider: it logs mail and exposes it at
`/_emdash/api/dev/emails`; it does not deliver real email. Configure a provider
for production mail.

## Local development

Use **Node 24.21.0** and **pnpm 11.9.0**. This repository is an independent
plugin package. From its root:

```sh
nvm use
export COREPACK_HOME="$PWD/.cache/corepack"
corepack pnpm install --frozen-lockfile
corepack pnpm validate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bundle
```

The bundle is written to `dist/automations-0.1.0.tar.gz`. It is a local artifact;
creating it does not publish a release. GitHub CI repeats these checks on Linux
and does not authenticate to the registry or deploy a site.

For development with an EmDash site, link this package into the site, build it,
and register the generated descriptor under `sandboxed` with the official
workerd runner. Run `corepack pnpm dev` in this repository to watch plugin
sources. Restart the site after descriptor rebuilds so the host loads the new
runtime. See the official [sandbox setup](https://docs.emdashcms.com/deployment/plugin-sandbox/).

CLI 0.13.2 needs the included one-line `src/**` → `src` Chokidar watch patch and
its TypeScript dependency override to 5.9.3. Both are recorded in this package's
pnpm configuration/lockfile; reassess them when updating the CLI.

Tests use the official production sandbox wrapper and bridge. Negative bridge
tests can print workerd exception diagnostics; assertions verify contained
failures and persisted results.

## Releases

The GitHub release workflow builds tags named `automations@<version>` using
Node 24.21.0, pnpm 11.9.0, and the locked plugin CLI. It validates the manifest,
checks types, and runs sandbox tests before building and attesting the bundle.
The workflow can also be started manually with the package selector
`automations@0.1.0` for the current candidate.

The package profile requires GitHub build provenance and publisher approval for
every release. The publisher must authorize publishing in the
[EmDash release dashboard](https://releases.emdashcms.com), approve the repository
connection on its first run, and approve each release with a passkey. Account
sessions remain outside Git and GitHub Actions secrets.

Update the package version before creating a release tag. Published versions
are immutable. After publication, check the registry listing and test installing
the release on a sandbox-enabled site before announcing it.

## Permissions and storage

| Capability | Reason |
| --- | --- |
| `content:read` | Content lifecycle hooks |
| `media:read` | Media upload hook |
| `schema:read` | Dynamic collection choices |
| `network:request:unrestricted` | Operator-defined webhook destinations |
| `email:send` | Official site email service |

No CMS write or user-read permissions. The private admin route is POST-only;
the host enforces authentication/CSRF and the handler requires role 50 (admin).
All interaction/form inputs and automation definitions are validated with Zod.
Conditional writes protect updates/deletes from concurrent edits.

Plugin-scoped structured storage:

- `automations`: `enabled`, `triggerType`, `updatedAt`, `[enabled, triggerType]`.
- `runs`: `automationId`, `startedAt`, `[automationId, startedAt]`.

Both use `schemaVersion: 1`; `triggerType` is a validated denormalized index.
The latest 100 runs are kept globally, including after automation deletion.
Runs store names, trigger/result, action statuses, sanitized errors and timestamps.
They do not store destination URLs, recipients, email bodies or full payloads.

## Architecture and extension

`plugin.ts` hooks → `triggers.ts` normalization → `engine.ts` indexed matching →
`actions.ts` sequential adapters → structured run storage and pruning.
`model.ts` owns schemas/tokens; `admin.ts` returns official Block Kit only.
No React, browser scripts or generic database layer is shipped.

To add a trigger: extend the model union, add a label/normalizer to
`triggerRegistry`, wire the official hook in `plugin.ts`, declare its capability,
and test its real runtime event. The form derives trigger choices from the registry.
Keep normalization allowlisted and avoid copying arbitrary event fields.

To add an action: extend `ActionSchema`, implement an adapter in `actionRegistry`,
add the corresponding form fields/validation, update the manifest if needed, and
test success/failure through the official host. The engine needs no new branch.
New schema versions require an explicit migration; unsupported records are
skipped instead of executed. Bump the release version for trust-contract changes.

## Limits

- Up to 25 automations through the editor and five actions per stored definition.
- Inline sequential execution: three-second wait per action, 15-second event
  budget, under the default 30-second sandbox invocation limit. Later actions
  receive a recorded budget failure if no time remains.
- AbortSignal does not cross the sandbox bridge. A timed-out operation may still
  deliver; no retries, durable queue, delivery confirmation or exactly-once claim.
- Failures are caught by plugin code. Sandbox hook `errorPolicy`/timeout/priority
  metadata is not relied on for recovery. A storage outage can lose run history;
  sanitized host logs remain the fallback. Retention resumes on the next event.
- No conditions, schedules, delays, HTML emails, custom webhook headers,
  multi-step editor, integrations, licensing/Pro, payments or AI.

## Official references

- [Hooks and isolated-runner behavior](https://docs.emdashcms.com/plugins/creating-plugins/hooks/)
- [Capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/)
- [Storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/)
- [Block Kit](https://docs.emdashcms.com/plugins/creating-plugins/block-kit/)
- [Routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/)
- [Testing](https://docs.emdashcms.com/plugins/creating-plugins/testing/)
- [Email](https://docs.emdashcms.com/guides/email/)

APIs were verified against official docs/MCP and installed EmDash 1.1.0
types/source. Before registry publication, authorize the selected publisher
account, review the release metadata, and complete the release checks. After
publication, verify a registry installation on a sandbox-enabled test site.

## License

MIT License

Copyright (c) 2026 HandyPlugins

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
