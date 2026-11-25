# Path workspaces: the manifest and the ledger (brainstorm → plan)

Status: implemented on `feat/workspaces` and merged into `experimental`: phases
1–4 in sequence, plus a live-review rework after phase 2 that moved the ledger
into a floating pane with lazy reads and multi-node linking. Phase 5 (images,
advisory linking, OS-folder reveal) remains deferred until a need shows.

## The question

Learning happens outside the harness. The learner keeps notes in a text editor
open beside LearnHarness, writes code in their own environment, reads PDFs in
their own viewer — and none of it can enter a path. The seams are visible in
the record today:

- `artifactNote` is a single optional string on a node. Principle 6's whole
  point is generative artifacts, yet the artifact itself lives nowhere.
- Uploaded sources can only enter a path as a spine or a supplement chosen at
  design time. There is no way to say "this paper is perfect for *this* node"
  mid-path.
- The Error Ledger's `notes` field is a single-string escape valve for
  reflection that wants to be a document.
- Map revisit asks the learner to redraw earlier relational maps from memory
  of scrollback, because nothing was ever saved.

## Decisions (resolved in review)

1. **One Workspace per path** (1:1). Cross-path discovery stays the Paths
   overview's job — its search already covers title, goal and learner tags,
   so nothing is lost by not making the workspace a multi-path container.
2. **The manifest is a current-state index, not an event log.** A snapshot
   with `updatedAt` and per-item provenance (`addedBy`, `addedAt`), validated
   and written with the store's existing discipline. No log-replay machinery.
3. **Brief injection is titles-only.** The child session brief lists linked
   items by kind and title; content stays behind a bounded read tool, so the
   brief remains small no matter how much material accumulates.
4. **Deleting a path deletes its workspace.** It is one learner decision; the
   guard is that removal only happens through the existing explicit
   `paths.delete` flow. Nothing else ever removes a workspace.
5. **Naming: "Workspace."** Workspace items, `workspace.*` RPCs, a Workspace
   section in the Node Inspector. The manifest is the ledger; files are the
   truth. ("Space" was rejected to avoid collision with the user's other
   tooling; "Workspace" reads as a place you work, not a curriculum.)
6. **Link relations for v1: `grounds`, `informs`, `produced_by`.** `evidence_of`
   ("this item is proof understanding held" — a solved problem set, a green
   test run) is deferred: anything it would capture enters today as a note or
   code item linked `informs`. It is one enum value to add when a need shows.
7. **Order: notes first.** The external-editor use case is the primary one;
   session-artifact saving (smaller diff) lands second.

## What a workspace is

Additive to the path record — the path schema is untouched, and a workspace
materializes lazily on first item, so existing data needs no migration.

```text
paths/<pathId>.json                  unchanged curriculum record
workspaces/<pathId>/manifest.json    versioned, validated, atomic
workspaces/<pathId>/files/<uuid>.md   item content, UUID names like sources/
```

- **Manifest = index, files = truth.** Entries never embed content; sha256
  gives dedup. Corrupt or newer manifests throw, never wipe.
- **`sources/` stays global.** A `source`-kind item *references* a `sourceId`;
  the ledger references, never copies. The Architect's existing chunked read
  tools keep working unchanged, and hash dedup across workspaces is preserved.
- **Learner-owned, agent-advised.** Agents write only their own
  `session_artifact` items. They never create, edit, link or delete learner
  items. Link suggestions (phase 5) reuse the pivots' advisory accept/dismiss
  pattern.

Item shape (validated in `src/domain.ts` beside the existing validators):

```ts
WORKSPACE_ITEM_KINDS = ["note", "session_artifact", "source", "code"]
WORKSPACE_LINK_RELS   = ["grounds", "informs", "produced_by"]

interface WorkspaceItemLink { to: string /* nodeId | "space" */, rel: WorkspaceLinkRel }
interface WorkspaceItem {
  id, kind, title,
  sourceId?,           // kind "source": reference into the global sources store
  byteSize?, sha256?,
  addedAt,
  addedBy: "learner" | "architect:<chatId>" | "session:<chatId>",
  caption?,
  links: WorkspaceItemLink[]
}
interface WorkspaceManifest { schemaVersion, pathId, updatedAt, items: WorkspaceItem[] }
```

Caps mirror existing conventions: title ≤ 200 chars, note content ≤ 256 KiB,
≤ 300 items per workspace, links validated against real node ids. A link to a
deleted node drops at read with the item kept — never data loss.

## Guardrails (framework discipline applied to stuff)

- No unread counts, no "new" badges, no inbox anxiety. The ledger is
  navigational, not judgmental. Counts are honest inventory, as elsewhere.
- No scheduling semantics may attach to an item: no dates beyond `addedAt`,
  no review queues, no "you haven't added anything in a while".
- Ungated: any item may link to any node regardless of progression state.
- Notes round-trip Markdown verbatim — the learner's editor is the source of
  truth for their own writing; the workspace never reformats it.

## Phases

Each is one reviewable change, on its own space branch off `feat/ui-upgrades`.

1. **Store** (`workspace 1/4`). Domain kinds/rels/validators/caps; store
   functions for manifest and content files; `paths.delete` extended to
   remove the workspace directory. No RPCs, no UI.
2. **Notes end-to-end** (`workspace 2/4`). `workspace.*` RPCs; a Workspace
   section in the Node Inspector (add note, link/unlink, delete); the brief's
   titles-only "Learner workspace material" section plus the bounded
   `learning_path_read_workspace_item` per-turn tool; Markdown export gains a
   Workspace section with note content verbatim. README and FRAMEWORK gain
   their Workspace entries here, with the first user-visible surface.
3. **Session artifacts** (`workspace 3/4`). `learning_path_save_artifact`
   per-turn tool: a session that produced its recommended artifact saves the
   full text as an item, auto-linked `produced_by` → node, `addedBy` the
   session chat. `artifactNote` stays as the agent's short summary. Map
   revisit then cites the learner's *saved* relational maps.
4. **Generalized uploads** (`workspace 4/4`). The Architect Pane upload flow
   can file a converted document as a node-linked workspace item (`grounds`)
   instead of only as spine corpus; Architect refinement context lists
   node-linked items by title.

## Out of scope (v1)

- **Images** (phase 5 candidate): a `kind: "image"` ledger entry with a learner
  caption, content stored but not agent-readable — no OCR, the same honesty
  as `ctx.documents.toMarkdown` refusing image-only PDFs.
- **Advisory link suggestions** (phase 5 candidate): sessions propose links
  the learner accepts or dismisses; agents never write learner-item links.
- Any auto-tagging, auto-summarizing or auto-arranging of learner material.

## Live-review overrides after phase 2

From hands-on testing of the notes surface, recorded in the same spirit as the
hub-views proposal's overrides:

1. **The ledger moved out of the Node Inspector into a pop-out pane.** The
   inline section read as cramped ("grounded") and made the inspector heavy;
   the inspector now shows one calm affordance, and the pane — floating,
   closable, scrollable, following the Paths overview's floating detailed-view
   pattern — carries the list. Note content loads on demand, only when a note
   is opened for viewing: the pane lists titles, `workspace.readItem` fetches
   the body.
2. **Filing loosened from the inspected node.** Adding a note per node is
   onerous; a note may now be created unlinked and linked to several nodes at
   once (a node picker in the pane, rel `informs`, through the existing
   `workspace.updateItemMeta` links array). The per-node flow remains but is
   no longer the only path.
3. **Opening the OS directory that holds workspace files is deferred.** The
   host exposes no reveal-a-folder primitive, and the plugin does not spawn
   processes off-contract. Drag-and-drop of files onto the pane is the
   plugin-side equivalent and lands with the uploads phase.
