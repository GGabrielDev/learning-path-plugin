/** Learning Path — the Workspace ledger pane.
 *
 * A floating, closable, scrollable pane over the Path Hub, opened from the Node
 * Inspector's single Workspace affordance (the inline list left the inspector
 * after live review — see docs/proposals/workspace-manifest.md, "Live-review
 * overrides"). The pane is one flat, navigational inventory of the learner's
 * own material for one path: metadata only, newest last, an honest item count.
 * The guardrails are binding: no unread counts, no "new" badges, and no
 * scheduling semantics of any kind — the ledger records what exists, never
 * what is owed.
 *
 * Content is lazy: the pane lists titles only, and an item's Markdown body is
 * fetched through `workspace.readItem` (read-only, bounded) only when the
 * learner opens it in the pane's viewer. A `source` item references the global
 * sources store and carries no content file, so its viewer says so instead of
 * fetching nothing.
 *
 * Multi-node filing: a note is created unlinked or linked to several nodes at
 * once, and any item's links are edited from the pane through a node picker
 * (rel `informs` for new links, existing relations preserved) via the existing
 * `workspace.updateItemMeta` links array.
 *
 * Dropped documents: PDF/text files dropped onto the pane are converted
 * through `ctx.documents.toMarkdown` (the Architect pane's pipeline) and filed
 * as node-linked `source` items (rel `grounds`) through one learner write,
 * `workspace.saveSource`. The manifest entry references the global source
 * library's id; content is never copied into the workspace.
 *
 * Learner-only writes. Agents never create, edit, link or delete learner
 * items. Everything rendered here is controlled by the caller (path, node and
 * workspace after each refetch) and every widget belongs to the per-mount
 * signal.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type {
  LearningPath,
  PathNode,
  WorkspaceItem,
  WorkspaceItemLink,
  WorkspaceManifest,
} from "../domain.ts";
import { WORKSPACE_ITEM_KINDS } from "../domain.ts";

export interface AddNoteInput {
  readonly title: string;
  readonly markdown: string;
  /** Node links filed with the note; empty means the note starts unlinked. */
  readonly links: readonly WorkspaceItemLink[];
}

export interface AddSourceInput {
  /** The converted document's name and Markdown (already through the global
   * conversion pipeline; the backend stores it once, hash-deduplicated). */
  readonly name: string;
  readonly markdown: string;
  /** Node links filed with the document (rel `grounds`). */
  readonly links: readonly WorkspaceItemLink[];
}

/** Documents file as `grounds`: source material a node's understanding stands
 * on. Notes keep the learner's `informs` filing; one rel per material kind. */
export const DOCUMENT_LINK_REL = "grounds";

/** The file types the conversion pipeline accepts, shared with the Architect
 * pane's picker: PDFs and UTF-8 text/markdown documents. */
export const UPLOAD_ACCEPT_TYPES = ".pdf,.md,.markdown,.txt,.text,application/pdf,text/plain,text/markdown";

/** True when a dropped file is one the conversion pipeline can take. */
export function isConvertibleFile(file: { name: string; type?: string }): boolean {
  const type = file.type ?? "";
  if (type === "application/pdf" || type === "text/plain" || type === "text/markdown") return true;
  return /\.(pdf|md|markdown|txt|text)$/i.test(file.name);
}

export interface WorkspacePaneOptions {
  /** Persist a new note through the plugin backend (workspace.saveNote). */
  saveNote(input: AddNoteInput): void | Promise<void>;
  /** Store a converted document in the global source library and file it as a
   * node-linked source item (workspace.saveSource: one learner write). */
  saveSource(input: AddSourceInput): void | Promise<void>;
  /** Replace one item's whole links array (learner filing). */
  setItemLinks(itemId: string, links: readonly WorkspaceItemLink[]): void | Promise<void>;
  /** Delete one workspace item and its content file. */
  deleteItem(itemId: string): void | Promise<void>;
  /** Lazy content read (workspace.readItem): resolved only when the learner
   * opens an item. Null content means the item carries no file (a source). */
  readItem(itemId: string): Promise<string | null>;
}

export interface WorkspacePane {
  render(path: LearningPath | null, node: PathNode | null, workspace: WorkspaceManifest | null): void;
  dispose(): void;
}

const KIND_LABELS: Readonly<Record<WorkspaceItem["kind"], string>> = {
  note: "Note",
  session_artifact: "Session artifact",
  source: "Source",
  code: "Code",
};

/** The rel learner filing uses for v1 (see docs/proposals/workspace-manifest.md). */
export const LEARNER_LINK_REL = "informs";

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspacePane(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: WorkspacePaneOptions,
): WorkspacePane {
  const document = container.ownerDocument;
  let disposed = false;
  let handles: PluginWidgetHandle<unknown>[] = [];
  /** Dialog handles live outside `container`, so they are tracked separately. */
  let dialogHandles: PluginWidgetHandle<unknown>[] = [];

  /** Viewer state survives the refetch-re-renders, so an open note stays open
   * with its already-fetched content instead of re-reading on every refresh. */
  let viewerItemId: string | null = null;
  let viewerContent: string | null = null;
  let viewerState: "loading" | "loaded" | "error" = "loaded";
  let viewerError = "";

  const clear = (): void => {
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    container.replaceChildren();
  };

  const button = (
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    extra: { variant?: "default" | "link" | "outline" | "ghost" | "secondary"; size?: "xs" | "sm"; title?: string } = {},
  ): void => {
    const host = element(document, "span", "lp-button-host");
    parent.append(host);
    handles.push(
      ctx.ui.mountButton(
        host,
        {
          label,
          variant: extra.variant ?? "outline",
          size: extra.size ?? "sm",
          ...(extra.title === undefined ? {} : { title: extra.title }),
          onClick: () => {
            if (!signal.aborted && !disposed) onClick();
          },
        },
        { signal },
      ),
    );
  };

  // The picker is the one filing surface: checkboxes, not drag order, never
  // progression. Exported so the Architect pane's upload dialog files identically.
  const buildPicker = (
    dialogDocument: Document,
    path: LearningPath,
    checkedNodeIds: ReadonlySet<string>,
  ): { root: HTMLElement; checked(): string[] } =>
    buildNodePicker(dialogDocument, path, checkedNodeIds);

  /** Add-note dialog: title, Markdown body, and a node picker defaulting to the
   * inspected node. An empty picker saves an unlinked note. */
  function openAddNoteDialog(path: LearningPath, node: PathNode | null): void {
    if (signal.aborted || disposed) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    dialog = ctx.ui.openDialog(
      {
        title: "Add Workspace Note",
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-note-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "The note is stored and exported exactly as written, for this path. Pick the nodes it belongs under; leave all unchecked to keep it unlinked.",
            ),
          );

          const titleLabel = element(dialogDocument, "label", "lp-field");
          titleLabel.append(element(dialogDocument, "span", "lp-field-label", "Title"));
          const titleInput = element(dialogDocument, "input", "lp-input");
          titleInput.setAttribute("aria-label", "Note title");
          titleLabel.append(titleInput);

          const bodyLabel = element(dialogDocument, "label", "lp-field");
          bodyLabel.append(element(dialogDocument, "span", "lp-field-label", "Note (Markdown)"));
          const bodyInput = element(dialogDocument, "textarea", "lp-textarea lp-workspace-note-body");
          bodyInput.setAttribute("aria-label", "Note content");
          bodyInput.rows = 10;
          bodyLabel.append(bodyInput);

          const pickerLabel = element(dialogDocument, "span", "lp-field-label", "Linked nodes");
          const picker = buildPicker(dialogDocument, path, new Set(node ? [node.id] : []));
          root.append(titleLabel, bodyLabel, pickerLabel, picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save Note",
              variant: "default",
              size: "sm",
              onClick: async () => {
                if (contentSignal.aborted) return;
                const title = titleInput.value.trim();
                const markdown = bodyInput.value;
                if (title.length === 0) {
                  error.textContent = "Give the note a title.";
                  error.hidden = false;
                  return;
                }
                if (markdown.trim().length === 0) {
                  error.textContent = "Write something first; an empty note cannot be saved.";
                  error.hidden = false;
                  return;
                }
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.saveNote({
                    title,
                    markdown,
                    links: picker.checked().map((nodeId) => ({ to: nodeId, rel: LEARNER_LINK_REL })),
                  });
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not save the note: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save Note" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);
          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
          };
        },
      },
      { signal },
    ) as PluginWidgetHandle<never>;
    dialogHandles.push(dialog);
  }

  /** Links dialog: one item's links across every node of the path. New links
   * are filed rel `informs`; relations already on the item keep their rel. */
  function openLinksDialog(path: LearningPath, item: WorkspaceItem): void {
    if (signal.aborted || disposed) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    const currentRels = new Map(item.links.map((link) => [link.to, link.rel]));
    dialog = ctx.ui.openDialog(
      {
        title: `Links — ${item.title}`,
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-links-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "File this item under every node it belongs to. New links are filed as informs; relations the item already carries keep their relation.",
            ),
          );
          const picker = buildPicker(
            dialogDocument,
            path,
            new Set(item.links.map((link) => link.to)),
          );
          root.append(picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save Links",
              variant: "default",
              size: "sm",
              onClick: async () => {
                if (contentSignal.aborted) return;
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.setItemLinks(
                    item.id,
                    picker.checked().map((nodeId) => ({
                      to: nodeId,
                      rel: currentRels.get(nodeId) ?? LEARNER_LINK_REL,
                    })),
                  );
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not save the links: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save Links" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);
          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
          };
        },
      },
      { signal },
    ) as PluginWidgetHandle<never>;
    dialogHandles.push(dialog);
  }

  /** Filing dialog for one dropped (or otherwise delivered) document: the file
   * is converted through `ctx.documents.toMarkdown` (the same pipeline the
   * Architect pane uses), the conversion notices surface here, and the picker
   * supplies the links (rel `grounds`). Saving goes through the caller's
   * `saveSource`, so the global source library stays the single store. The
   * picker may stay empty: the item then starts unlinked, like a note.
   * Resolves when the dialog closes (saved, cancelled or disposed). */
  function openAddSourceDialog(file: File): Promise<void> {
    if (signal.aborted || disposed) return Promise.resolve();
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    return new Promise<void>((resolve) => {
      dialog = ctx.ui.openDialog(
      {
        title: `File “${file.name}” in Workspace`,
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-source-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "The document is converted to Markdown and stored once in your source library; the workspace entry references it. Pick the nodes it grounds; leave all unchecked to keep it unlinked.",
            ),
          );
          const status = element(dialogDocument, "p", "lp-muted lp-workspace-source-status");
          status.setAttribute("role", "status");
          status.textContent = `Converting ${file.name}…`;
          const pickerLabel = element(dialogDocument, "span", "lp-field-label", "Linked nodes");
          const picker = buildPicker(
            dialogDocument,
            pathWithoutNull(),
            new Set(lastNode ? [lastNode.id] : []),
          );
          root.append(status, pickerLabel, picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save to Workspace",
              variant: "default",
              size: "sm",
              disabled: true,
              onClick: async () => {
                if (contentSignal.aborted || converted === null) return;
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.saveSource({
                    name: converted.name,
                    markdown: converted.markdown,
                    links: picker.checked().map((nodeId) => ({ to: nodeId, rel: DOCUMENT_LINK_REL })),
                  });
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not file the document: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save to Workspace" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);

          let converted: { name: string; markdown: string } | null = null;
          void (async () => {
            try {
              const result = await ctx.documents.toMarkdown(file, { signal: contentSignal });
              if (contentSignal.aborted) return;
              converted = { name: result.name, markdown: result.markdown };
              status.textContent = result.notices.length > 0 ? result.notices.join(" ") : "";
              save.update({ disabled: false, label: "Save to Workspace" });
            } catch (problem) {
              if (contentSignal.aborted) return;
              status.textContent = "";
              error.textContent = `Could not convert ${file.name}: ${describeError(problem)}`;
              error.hidden = false;
            }
          })();

          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
            resolve();
          };
        },
      },
      { signal },
      ) as PluginWidgetHandle<never>;
      dialogHandles.push(dialog);
    });
  }

  /** The dialog only opens from a rendered ledger, which always has a path
   * (onDrop refuses to queue while none is rendered). */
  function pathWithoutNull(): LearningPath {
    return lastPath as LearningPath;
  }

  /** Dropped documents queue one at a time: each conversion opens its filing
   * dialog, and the next file waits until the learner resolves the current one. */
  let dropQueue: File[] = [];
  let filingDrop = false;

  async function processDropQueue(): Promise<void> {
    if (filingDrop || signal.aborted || disposed) return;
    filingDrop = true;
    try {
      while (dropQueue.length > 0 && !signal.aborted && !disposed) {
        const file = dropQueue.shift()!;
        await openAddSourceDialog(file);
      }
    } finally {
      filingDrop = false;
    }
  }

  const onDragOver = (event: Event): void => {
    if (signal.aborted || disposed) return;
    event.preventDefault();
    container.classList.add("lp-drop-target");
  };
  const onDragLeave = (): void => {
    container.classList.remove("lp-drop-target");
  };
  const onDrop = (event: DragEvent): void => {
    if (signal.aborted || disposed) return;
    event.preventDefault();
    container.classList.remove("lp-drop-target");
    const files = [...(event.dataTransfer?.files ?? [])].filter(isConvertibleFile);
    if (files.length === 0 || lastPath === null) return;
    dropQueue.push(...files);
    void processDropQueue();
  };
  container.addEventListener("dragover", onDragOver, { signal });
  container.addEventListener("dragleave", onDragLeave, { signal });
  container.addEventListener("drop", onDrop as EventListener, { signal });

  /** Open the read-only viewer: the item's content is fetched now, on demand,
   * through `workspace.readItem` — never as part of listing the ledger. */
  function openViewer(item: WorkspaceItem): void {
    if (signal.aborted || disposed) return;
    viewerItemId = item.id;
    viewerContent = null;
    viewerState = "loading";
    viewerError = "";
    // The caller re-renders after the fetch resolves; the pane paints the
    // loading state immediately so the demand-read is visible.
    void (async () => {
      try {
        const content = await options.readItem(item.id);
        if (signal.aborted || disposed || viewerItemId !== item.id) return;
        viewerContent = content;
        viewerState = "loaded";
      } catch (problem) {
        if (signal.aborted || disposed || viewerItemId !== item.id) return;
        viewerState = "error";
        viewerError = describeError(problem);
      }
      rerender();
    })();
    rerender();
  }

  /** A source item references the global sources store; it has no content file
   * of its own, so the viewer says where its text lives instead. */
  const SOURCE_VIEWER_NOTE =
    "This source lives in the path's source library; its text is read there, not stored in the workspace.";

  function viewer(item: WorkspaceItem): HTMLElement {
    const root = element(document, "div", "lp-workspace-viewer");
    const head = element(document, "div", "lp-workspace-viewer-head");
    button(head, "Back to list", () => {
      viewerItemId = null;
      viewerContent = null;
      viewerState = "loaded";
      rerender();
    }, { variant: "outline" });
    const meta = element(document, "div", "lp-workspace-viewer-meta");
    meta.append(element(document, "p", "lp-workspace-item-title", item.title));
    meta.append(element(document, "span", "lp-muted", KIND_LABELS[item.kind] ?? item.kind));
    if (item.kind === "session_artifact" && item.addedBy.startsWith("session:")) {
      meta.append(
        element(document, "span", "lp-muted", `saved by ${item.addedBy.replace(":", " ")}`),
      );
    }
    head.append(meta);
    root.append(head);

    const body = element(document, "div", "lp-workspace-viewer-content");
    if (viewerState === "loading") {
      body.append(element(document, "p", "lp-muted", "Loading…"));
    } else if (viewerState === "error") {
      const error = element(document, "p", "lp-dialog-error", `Could not read the item: ${viewerError}`);
      error.setAttribute("role", "alert");
      body.append(error);
    } else if (item.kind === "source" || viewerContent === null) {
      body.append(element(document, "p", "lp-muted", SOURCE_VIEWER_NOTE));
    } else {
      const host = element(document, "div", "lp-workspace-viewer-markdown");
      body.append(host);
      // Read-only rendering: mountMarkdown draws the stored Markdown verbatim.
      handles.push(ctx.ui.mountMarkdown(host, { text: viewerContent }, { signal }));
    }
    root.append(body);
    return root;
  }

  /** One flat ledger row: title (opens the viewer), kind, links, actions. */
  function itemRow(
    item: WorkspaceItem,
    path: LearningPath,
    node: PathNode | null,
  ): HTMLElement {
    const row = element(document, "li", "lp-workspace-row");
    row.dataset.itemId = item.id;
    const title = element(document, "span", "lp-workspace-row-title");
    // The title itself is the affordance: opening the viewer is the row's
    // primary action, and the content is only fetched at that moment.
    button(title, item.title, () => openViewer(item), {
      variant: "link",
      title: `Open ${item.title}`,
    });
    row.append(title);
    row.append(element(document, "span", "lp-muted", KIND_LABELS[item.kind] ?? item.kind));
    // Honest inventory of where the item is filed; no unread or new state.
    const nodeTitles = item.links.flatMap((link) => {
      const target = path.modules.flatMap((module) => module.nodes).find((candidate) => candidate.id === link.to);
      return target ? [`${target.title} (${link.rel})`] : [];
    });
    if (nodeTitles.length > 0) {
      row.append(element(document, "span", "lp-muted lp-workspace-links", `linked: ${nodeTitles.join(", ")}`));
    } else {
      row.append(element(document, "span", "lp-muted lp-workspace-links", "unlinked"));
    }
    if (node && item.links.some((link) => link.to === node.id)) {
      row.append(element(document, "span", "lp-muted", "linked here"));
    }
    // Session artifacts carry their provenance: which session saved them.
    if (item.kind === "session_artifact" && item.addedBy.startsWith("session:")) {
      row.append(
        element(document, "span", "lp-muted", `saved by ${item.addedBy.replace(":", " ")}`),
      );
    }
    const actions = element(document, "span", "lp-workspace-row-actions");
    row.append(actions);
    button(actions, "Links…", () => openLinksDialog(path, item), { title: `Edit links for ${item.title}` });
    button(actions, "Delete", () => {
      void options.deleteItem(item.id);
    }, { variant: "ghost" });
    return row;
  }

  function rerender(): void {
    // Re-render with the caller's last-seen state; render() stores it.
    renderState(lastPath, lastNode, lastWorkspace);
  }

  let lastPath: LearningPath | null = null;
  let lastNode: PathNode | null = null;
  let lastWorkspace: WorkspaceManifest | null = null;

  function renderState(
    path: LearningPath | null,
    node: PathNode | null,
    workspace: WorkspaceManifest | null,
  ): void {
    if (disposed || signal.aborted) return;
    const scroll = container.scrollTop;
    clear();
    lastPath = path;
    lastNode = node;
    lastWorkspace = workspace;
    if (!path) return;

    const items = [...(workspace?.items ?? [])].sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );

    const viewerItem = viewerItemId === null ? null : items.find((item) => item.id === viewerItemId) ?? null;
    if (viewerItemId !== null && viewerItem === null) {
      // The open item is gone (deleted); the list is the honest state.
      viewerItemId = null;
      viewerContent = null;
      viewerState = "loaded";
    }

    const header = element(document, "div", "lp-workspace-header");
    // Honest inventory only: no unread counts, no "new" badges anywhere.
    header.append(
      element(document, "span", "lp-muted", `${items.length} item${items.length === 1 ? "" : "s"}`),
    );
    const addHost = element(document, "span", "lp-button-host");
    header.append(addHost);
    container.append(header);
    handles.push(
      ctx.ui.mountButton(
        addHost,
        {
          label: "Add Note",
          variant: "default",
          size: "sm",
          onClick: () => {
            if (!signal.aborted && !disposed) openAddNoteDialog(path, node);
          },
        },
        { signal },
      ),
    );

    if (viewerItem !== null) {
      container.append(viewer(viewerItem));
      return;
    }

    if (items.length === 0) {
      container.append(
        element(
          document,
          "p",
          "lp-muted",
          "No workspace items yet. Add a note to keep your own material with this path.",
        ),
      );
      return;
    }

    const list = element(document, "ul", "lp-workspace-list");
    // Newest last: the ledger reads like a flat history of what was added.
    for (const item of items) list.append(itemRow(item, path, node));
    container.append(list);
    container.scrollTop = scroll;
  }

  return {
    render(path, node, workspace) {
      if (disposed || signal.aborted) return;
      renderState(path, node, workspace);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (const handle of dialogHandles.reverse()) handle.dispose();
      dialogHandles = [];
      container.replaceChildren();
    },
  };
}

/** Exported for tests and the Architect pane's upload dialog: every node of
 * the path, module order, as picker options. The picker is the one filing
 * surface: checkboxes, not drag order, never progression. */
export function nodeOptions(path: LearningPath): readonly { nodeId: string; title: string; moduleTitle: string }[] {
  return path.modules.flatMap((module) =>
    module.nodes.map((node) => ({ nodeId: node.id, title: node.title, moduleTitle: module.title })),
  );
}

export function buildNodePicker(
  dialogDocument: Document,
  path: LearningPath,
  checkedNodeIds: ReadonlySet<string>,
): { root: HTMLElement; checked(): string[] } {
  const root = element(dialogDocument, "div", "lp-workspace-picker");
  root.setAttribute("aria-label", "Node picker");
  const inputs = new Map<string, HTMLInputElement>();
  for (const option of nodeOptions(path)) {
    const label = element(dialogDocument, "label", "lp-workspace-picker-option");
    const input = element(dialogDocument, "input", "lp-checkbox");
    input.type = "checkbox";
    input.value = option.nodeId;
    input.checked = checkedNodeIds.has(option.nodeId);
    input.setAttribute(
      "aria-label",
      `Link to ${option.title} (${option.moduleTitle})`,
    );
    inputs.set(option.nodeId, input);
    label.append(input);
    label.append(element(dialogDocument, "span", undefined, option.title));
    root.append(label);
  }
  return {
    root,
    checked: () => [...inputs.entries()].filter(([, input]) => input.checked).map(([nodeId]) => nodeId),
  };
}

/** Exported for tests: the kinds a ledger row can show. */
export const WORKSPACE_KINDS = WORKSPACE_ITEM_KINDS;
