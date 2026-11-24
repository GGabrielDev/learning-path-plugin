# Native LearnHarness folders ↔ Learning Path multi-chat attachment research

**Date:** 2026-11-23
**Question:** Can native LearnHarness chat folders be combined with Learning Path's existing ability to attach multiple chats to a node without private APIs, host-data writes, inferred mastery, or production data?
**Decision target:** choose a bounded experimental first slice and identify any SDK gap.
**Inspected revisions:** Learning Path `experimental` `7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb`; LearnHarness tag `v0.7.0` `a2383f8b5557c508926282da22d7d941c1aadafe` (peeled source commit `0292b85bcce080cc685f85d174a8cb2cc553a0ad`). Source inspection only; tests were not run.

## Answer

Native folders are visible in LearnHarness's internal source-organization model, but **the public plugin SDK v0.7.0 does not expose folder membership or folder actions**. The SDK does expose read-only chat summaries/records and live `sources-changed` hints. Learning Path can therefore implement a safe first slice using its existing public chat listing and plugin-owned link records, but cannot offer a native-folder picker or folder snapshot without an upstream SDK addition.

Learning Path already supports **many distinct chats on one node** (`childSessions` is an array), while its attach RPC enforces **one parent node per native chat across all saved paths**. The current UI links one chat at a time. These are separate constraints: the per-chat ownership rule is an attach-RPC invariant, not a native folder or storage limitation.

## Evidence: ownership and cardinality

- The plugin owns only the `ChildSessionLink` mapping; the native chat remains host-owned. [`src/session-links.ts` lines 1–7](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/session-links.ts#L1-L7)
- `findChatLink` searches all stored paths and returns the single location for a chat. [`src/session-links.ts` lines 41–53](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/session-links.ts#L41-L53)
- `addChildLink` appends a distinct chat to a node and rejects only a duplicate on that same node; there is no one-per-kind or per-node cap. [`src/session-links.ts` lines 76–99](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/session-links.ts#L76-L99)
- The attach backend checks native existence/kind, then rejects a different parent if the chat is already found elsewhere; same-target retry is idempotent. [`src/backend.ts` lines 770–840](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/backend.ts#L770-L840)
- The node view renders each `childSessions` entry independently. [`src/view/path-hub.ts` lines 339–370](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/view/path-hub.ts#L339-L370)

## Current manual picker and bulk implications

The existing `sessions.available` response derives chat metadata from `ctx.learning.listSessions()` and reports plugin parent-link state; it has no folder field. The existing “Link Existing Session” dialog fixes one destination node, filters out all linked chats, and presents one Link button per row; successful linking closes the dialog. [`src/backend.ts` lines 863–887](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/backend.ts#L863-L887) · [`src/view/session-dialogs.ts` lines 258–378](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/view/session-dialogs.ts#L258-L378)

A bounded multi-select could reuse this public contract: select chats for one named node, deduplicate IDs, confirm explicitly, and submit a new plugin operation. Repeating `sessions.link` is not all-or-nothing: each save replaces one plugin path record and emits a change, so a later failure leaves earlier links. The plugin's atomic file replacement protects each write, not the sequence. [`src/backend.ts` lines 795–819](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/backend.ts#L795-L819) · [`src/store.ts` lines 344–359](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36eb/src/store.ts#L344-L359)

## Host folder model vs public SDK

LearnHarness `v0.7.0` internally models a folder as stable `id`, `name`, `parentId`, `createdAt`, with a separate placement map from source/chat IDs to one `folderId`; this is presentation organization, not chat identity. [`src/core/source-organization.ts` lines 1–35](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/src/core/source-organization.ts#L1-L35)

The internal source directory is assembled from every chat plus notes and missing graph references, and internal actions can create, move, rename, and delete folders. [`src/server/source-organization.ts` lines 13–52](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/src/server/source-organization.ts#L13-L52) · [`src/core/source-organization.ts` lines 41–46](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/src/core/source-organization.ts#L41-L46)

The public SDK instead exposes `PluginLearningData.listSessions()` and `getSession()` as read-only native learning access; it does not expose folders, placements, folder membership, or folder mutation. [`src/core/plugins.ts` lines 69–85](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/src/core/plugins.ts#L69-L85) · [generated SDK reference](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/docs/plugin-api/plugins.md#L1491-L1544)

The public event vocabulary includes `sources-changed` for source inventory/display names/organizational folders, but it carries no folder snapshot or membership payload; the SDK says events are hints and callers should re-read authoritative state. [`events.ts` lines 158–174](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/docs/plugin-api/events.md#L158-L174) · [`plugins.ts` lines 180–189](https://github.com/amosblomqvist/learnharness/blob/0292b85bcce080cc685f85d174a8cb2cc553a0ad/src/core/plugins.ts#L180-L189)

## Options

### 1. Manual batch picker — recommended thin first slice

- Use `listSessions()` plus existing plugin link lookup.
- Add bounded multi-select for one selected node.
- On explicit confirmation, backend revalidates every ID, preserves one-chat ownership, and returns per-item outcomes (`added`, `already linked`, `conflict`, `missing`, `invalid kind`).
- No native folder reads/writes, no transcript copy, no graph writes, no progression or mastery inference.
- Treat the operation as partial-success unless a separate transaction design is agreed; surface failures rather than silently retrying or transferring ownership.

This is implementable today with public SDK surfaces, but remains a plugin-only selection—not a native folder integration.

### 2. Folder snapshot staging with per-node confirmation — safe only after SDK support

Desired flow: read a folder's current chat-member snapshot, let the learner stage it, then explicitly confirm which chats attach to each node. This avoids silently treating folder membership as mastery and allows edits before writes. However, the public SDK has no way to obtain the snapshot. An upstream read-only folder-member API (stable folder IDs, member chat IDs/metadata, bounded pagination/limits) would be required. The plugin still must not mutate native folders.

### 3. Live sync — not recommended for the first slice

A `sources-changed` subscription can tell the plugin to invalidate/re-read, but cannot identify members or express desired mapping. Even with a future folder read API, automatic attach/detach would create host-to-plugin writes, ownership conflicts, destructive surprises, and implied progression. Keep live events as cache invalidation only; require explicit per-node confirmation for every link.

## Recommendation / SDK gap

Open a focused experimental issue for the manual batch picker now. The first PR should be documentation/design or a small UI-only slice behind the existing experimental boundary, with no host data writes. Separately propose a public, read-only `learning.listFolders()` / `learning.listFolderMembers(folderId)` contract (or equivalent snapshot response) plus a `sources-changed` revision/token if native-folder integration is a priority. Do not expose internal source-organization types or private routes as a workaround.

No claim is made about mastery: a linked chat is evidence of learner-selected association only. No host data writes, private APIs, or production learner data were used in this research.
