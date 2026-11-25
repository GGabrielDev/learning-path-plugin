/** Learning Path — the Workspace ledger inside the Node Inspector.
 *
 * A flat, navigational inventory of the learner's own material for one path:
 * one list, newest last, with an honest item count. The guardrails are binding:
 * no unread counts, no "new" badges, and no scheduling semantics of any kind —
 * the ledger records what exists, never what is owed.
 *
 * Learner-only writes: add a note (Markdown stored verbatim), link or unlink an
 * item to the inspected node, delete an item. Agents never create, edit, link
 * or delete learner items. Everything rendered here is controlled by the caller
 * (path, node and workspace after each refetch) and every widget belongs to the
 * per-mount signal.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { LearningPath, PathNode, WorkspaceItem, WorkspaceManifest } from "../domain.ts";
import { WORKSPACE_ITEM_KINDS } from "../domain.ts";

export interface AddNoteInput {
  readonly title: string;
  readonly markdown: string;
  readonly linkToNode: boolean;
}

export interface WorkspaceLedgerOptions {
  /** Persist a new note through the plugin backend (workspace.saveNote). */
  saveNote(input: AddNoteInput): void | Promise<void>;
  /** Link one item to the inspected node (learner filing, rel "informs"). */
  linkItem(itemId: string): void | Promise<void>;
  /** Remove the inspected node's link from one item; the item stays. */
  unlinkItem(itemId: string): void | Promise<void>;
  /** Delete one workspace item and its content file. */
  deleteItem(itemId: string): void | Promise<void>;
}

export interface WorkspaceLedger {
  render(path: LearningPath | null, node: PathNode | null, workspace: WorkspaceManifest | null): void;
  dispose(): void;
}

const KIND_LABELS: Readonly<Record<WorkspaceItem["kind"], string>> = {
  note: "Note",
  session_artifact: "Session artifact",
  source: "Source",
  code: "Code",
};

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

/** The rel learner filing uses for v1 (see docs/proposals/workspace-manifest.md). */
export const LEARNER_LINK_REL = "informs";

export function createWorkspaceLedger(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: WorkspaceLedgerOptions,
): WorkspaceLedger {
  const document = container.ownerDocument;
  let disposed = false;
  let handles: PluginWidgetHandle<unknown>[] = [];
  /** Dialog handles live outside `container`, so they are tracked separately. */
  let dialogHandles: PluginWidgetHandle<unknown>[] = [];

  const clear = (): void => {
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    container.replaceChildren();
  };

  const button = (
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    extra: { variant?: "default" | "link" | "outline" | "ghost" | "secondary"; size?: "xs" | "sm" } = {},
  ): void => {
    const host = element(document, "span", "lp-button-host");
    parent.append(host);
    handles.push(
      ctx.ui.mountButton(
        host,
        {
          label,
          variant: extra.variant ?? "outline",
          size: extra.size ?? "xs",
          onClick: () => {
            if (!signal.aborted && !disposed) onClick();
          },
        },
        { signal },
      ),
    );
  };

  /** Add-note dialog: title, Markdown body, and an opt-in link to the node. */
  function openAddNoteDialog(node: PathNode): void {
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
              `The note is stored and exported exactly as written, for the path this node belongs to.`,
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

          const linkLabel = element(dialogDocument, "label", "lp-field lp-workspace-note-link");
          const linkInput = element(dialogDocument, "input", "lp-checkbox");
          linkInput.type = "checkbox";
          linkInput.checked = true;
          linkLabel.append(linkInput);
          linkLabel.append(
            element(dialogDocument, "span", "lp-field-label", `Link to "${node.title}"`),
          );

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(titleLabel, bodyLabel, linkLabel, error, saveHost);
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
                  await options.saveNote({ title, markdown, linkToNode: linkInput.checked });
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not save the note: ${
                    problem instanceof Error ? problem.message : String(problem)
                  }`;
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

  /** One flat ledger row: kind, title, link state, learner actions. */
  function itemRow(
    item: WorkspaceItem,
    path: LearningPath,
    node: PathNode,
  ): HTMLElement {
    const row = element(document, "li", "lp-workspace-row");
    row.dataset.itemId = item.id;
    const linkToNode = item.links.find((link) => link.to === node.id);
    const label = element(document, "span", "lp-workspace-label", item.title);
    row.append(label);
    row.append(
      element(document, "span", "lp-muted", `${KIND_LABELS[item.kind] ?? item.kind}`),
    );
    if (linkToNode) {
      row.append(element(document, "span", "lp-muted", `linked (${linkToNode.rel})`));
    }
    // Session artifacts carry their provenance: which session saved them.
    if (item.kind === "session_artifact" && item.addedBy.startsWith("session:")) {
      row.append(
        element(document, "span", "lp-muted", `saved by ${item.addedBy.replace(":", " ")}`),
      );
    }
    const actions = element(document, "span", "lp-workspace-row-actions");
    row.append(actions);
    if (linkToNode) {
      button(actions, "Unlink from node", () => {
        void options.unlinkItem(item.id);
      }, { variant: "ghost" });
    } else {
      button(actions, `Link to node`, () => {
        void options.linkItem(item.id);
      }, { variant: "ghost" });
    }
    button(actions, "Delete", () => {
      void options.deleteItem(item.id);
    }, { variant: "ghost" });
    return row;
  }

  return {
    render(path, node, workspace) {
      if (disposed || signal.aborted) return;
      clear();
      if (!path || !node) return;

      const items = [...(workspace?.items ?? [])].sort((a, b) =>
        a.addedAt.localeCompare(b.addedAt),
      );

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
            size: "xs",
            onClick: () => {
              if (!signal.aborted && !disposed) openAddNoteDialog(node);
            },
          },
          { signal },
        ),
      );

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

/** Exported for tests: the kinds a ledger row can show. */
export const WORKSPACE_KINDS = WORKSPACE_ITEM_KINDS;
