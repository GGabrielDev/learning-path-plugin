/** Paths overview — the Path Hub's dashboard surface.
 *
 * One card per learning path with honest inventory: module/node counts, a
 * node-state distribution strip that always carries labels and counts (color
 * never stands alone), pending pivots and unresolved watchpoints. Learner-owned
 * grouping tags file a path under an exam, field or project; a tag filter
 * groups cards client-side, and tag edits go through `paths.updateMeta`.
 *
 * There is deliberately no scheduling surface here: no dates, hours, streaks
 * or completion percentages. The Architect has no tool that writes tags, so
 * how a path is filed never drifts from what it teaches.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { MAX_PATH_TAGS, MAX_PATH_TAG_LENGTH } from "../domain.ts";
import type { PathSummary } from "./path-hub.ts";

export interface PathsOverviewOptions {
  /** A card click switches the hub to that path, like the header select. */
  selectPath(pathId: string): void;
  /** Called once after a successful tag save; the hub refetches. */
  tagsChanged(): void;
}

export interface PathsOverview {
  render(summaries: readonly PathSummary[], selectedPathId: string | null): void;
  dispose(): void;
}

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

/** linkedom does not reflect `select.value`; read the selected option instead. */
function selectedValue(select: HTMLSelectElement): string {
  return (
    select.value ||
    [...select.options].find((option) => option.selected)?.value ||
    ""
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Distinct tags across all paths, first-seen casing, alphabetical. */
function distinctTags(summaries: readonly PathSummary[]): readonly string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const summary of summaries) {
    for (const tag of summary.tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
  }
  return tags.sort((a, b) => a.localeCompare(b));
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function tagMatches(tag: string, filter: string | null): boolean {
  return filter === null || tag.toLowerCase() === filter.toLowerCase();
}

/** The only orderings the overview offers. Neither implies priority: there is
 * no "smart" order and no notion of a path being stale. */
type SortKey = "updated" | "title";

const DEFAULT_SORT: SortKey = "updated";

const SORT_OPTIONS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title A–Z" },
];

function updatedTime(summary: PathSummary): number {
  const time = Date.parse(summary.updatedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Deterministic under either key: ties fall through to title, then id, so the
 * order never depends on the order `paths.list` happened to return. */
function inSortOrder(summaries: readonly PathSummary[], sort: SortKey): PathSummary[] {
  return [...summaries].sort((a, b) => {
    if (sort === "updated") {
      const byUpdated = updatedTime(b) - updatedTime(a);
      if (byUpdated !== 0) return byUpdated;
    }
    const byTitle = a.title.localeCompare(b.title);
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
  });
}

/** Paths per tag, keyed lowercase so casing never splits a group. A path counts
 * once per tag even if the record repeats it. */
function tagCounts(summaries: readonly PathSummary[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    const seen = new Set<string>();
    for (const tag of summary.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Parse and locally validate a comma-separated tag entry. Returns precise
 * learner-readable errors; the backend re-validates with the same domain rules. */
function parseTagEntry(raw: string): { tags: readonly string[]; error: string | null } {
  const tags = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tags.length > MAX_PATH_TAGS) {
    return { tags, error: `A path carries at most ${MAX_PATH_TAGS} tags.` };
  }
  for (const tag of tags) {
    if (tag.length > MAX_PATH_TAG_LENGTH) {
      return { tags, error: `Each tag is at most ${MAX_PATH_TAG_LENGTH} characters.` };
    }
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      return { tags, error: `Duplicate tag "${tag}" — tags ignore letter case.` };
    }
    seen.add(key);
  }
  return { tags, error: null };
}

export function createPathsOverview(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PathsOverviewOptions,
): PathsOverview {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-overview");
  root.setAttribute("aria-label", "Paths overview");
  container.append(root);

  let handles: PluginWidgetHandle<unknown>[] = [];
  let disposed = false;
  let filterTag: string | null = null;
  let sortKey: SortKey = DEFAULT_SORT;
  let latestSummaries: readonly PathSummary[] = [];

  const clear = (): void => {
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    root.replaceChildren();
  };

  const badge = (parent: HTMLElement, text: string, color: string): void => {
    const host = element(document, "span", "lp-badge-host");
    parent.append(host);
    handles.push(ctx.ui.mountBadge(host, { text, color }, { signal }));
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

  /** Tags are learner filing. The dialog is the only writer, and it saves
   * through `paths.updateMeta`, never through the Architect conversation. */
  function openTagsDialog(summary: PathSummary): void {
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };

    dialog = ctx.ui.openDialog(
      {
        title: `Edit tags — ${summary.title}`,
        content: (contentContainer: HTMLElement, contentSignal: AbortSignal) => {
          const doc = contentContainer.ownerDocument;
          const dialogRoot = element(doc, "div", "lp-tags-dialog");
          dialogRoot.append(
            element(
              doc,
              "p",
              "lp-muted",
              "Group this path by an exam, field or project. Comma-separated; tags are filing, never scheduling.",
            ),
          );
          const field = element(doc, "label", "lp-field");
          field.append(element(doc, "span", "lp-field-label", "Tags"));
          const input = doc.createElement("input");
          input.className = "lp-input lp-tags-input";
          input.setAttribute("type", "text");
          input.setAttribute("aria-label", "Tags, comma-separated");
          input.value = summary.tags.join(", ");
          field.append(input);
          dialogRoot.append(field);
          const status = element(doc, "p", "lp-dialog-status");
          status.setAttribute("role", "status");
          const error = element(doc, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;
          dialogRoot.append(status, error);
          const actions = element(doc, "div", "lp-dialog-actions");
          dialogRoot.append(actions);
          contentContainer.append(dialogRoot);

          const dialogHandles: PluginWidgetHandle<unknown>[] = [];
          let saving = false;

          const saveTags = async (): Promise<void> => {
            if (contentSignal.aborted || signal.aborted || saving) return;
            const parsed = parseTagEntry(input.value);
            if (parsed.error !== null) {
              status.textContent = "";
              error.textContent = parsed.error;
              error.hidden = false;
              return;
            }
            saving = true;
            try {
              await ctx.call("paths.updateMeta", { pathId: summary.id, tags: parsed.tags });
              if (contentSignal.aborted || signal.aborted) return;
              status.textContent = "Tags saved.";
              options.tagsChanged();
              close();
            } catch (problem) {
              status.textContent = "";
              error.textContent = describeError(problem);
              error.hidden = false;
            } finally {
              saving = false;
            }
          };

          dialogHandles.push(
            ctx.ui.mountButton(
              actions,
              {
                label: "Save tags",
                variant: "default",
                size: "sm",
                onClick: () => {
                  void saveTags();
                },
              },
              { signal: contentSignal },
            ),
          );

          return () => {
            for (const handle of dialogHandles.reverse()) handle.dispose();
            dialogHandles.length = 0;
            dialogRoot.remove();
          };
        },
        onClose: close,
      },
      { signal },
    );
  }

  function card(summary: PathSummary, selected: boolean): void {
    const cards = root.querySelector<HTMLElement>(".lp-overview-cards");
    if (!cards) return;
    const cardRoot = element(document, "article", "lp-path-card");
    cardRoot.setAttribute("data-path-id", summary.id);
    if (selected) cardRoot.classList.add("lp-path-card-selected");
    if (summary.tags.some((tag) => tagMatches(tag, filterTag))) {
      cardRoot.classList.add("lp-path-card-filtered-in");
    }

    const header = element(document, "header", "lp-path-card-header");
    button(header, summary.title, () => options.selectPath(summary.id), { variant: "link", size: "sm" });
    button(header, "Edit tags", () => openTagsDialog(summary), { variant: "outline", size: "xs" });
    cardRoot.append(header);

    // The whole card selects the path; the title button stays the accessible
    // control. Clicks landing on a card's own buttons keep their own action.
    cardRoot.addEventListener("click", (event) => {
      if (disposed || signal.aborted) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".lp-button-host")) return;
      options.selectPath(summary.id);
    });

    cardRoot.append(element(document, "p", "lp-path-card-goal", summary.goal));
    cardRoot.append(
      element(
        document,
        "p",
        "lp-muted",
        `${summary.sourceMode === "canonical" ? "Canonical" : "Uploaded"} · ${summary.sourceTitles.join(", ")}`,
      ),
    );
    cardRoot.append(
      element(
        document,
        "p",
        "lp-muted",
        `${countLabel(summary.moduleCount, "module")} · ${countLabel(summary.nodeCount, "node")}`,
      ),
    );

    // Honest inventory: the strip always ships with its labeled counts, so the
    // meaning never rides on color alone.
    const states = summary.nodeStates;
    const total = states.unstarted + states.in_progress + states.consolidated;
    const distributionText = `${states.consolidated} consolidated · ${states.in_progress} in progress · ${states.unstarted} unstarted`;
    const strip = element(document, "div", "lp-distribution");
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", distributionText);
    for (const state of ["consolidated", "in_progress", "unstarted"] as const) {
      const segment = element(document, "span", `lp-distribution-segment lp-distribution-${state}`);
      segment.style.flexGrow = total === 0 ? "1" : String(states[state]);
      strip.append(segment);
    }
    cardRoot.append(strip, element(document, "p", "lp-muted", distributionText));

    if (summary.pendingPivotCount > 0 || summary.unresolvedErrorCount > 0) {
      const badges = element(document, "div", "lp-badge-row");
      if (summary.pendingPivotCount > 0) {
        badge(badges, countLabel(summary.pendingPivotCount, "pending pivot"), "var(--chart-3, #f59e0b)");
      }
      if (summary.unresolvedErrorCount > 0) {
        badge(badges, countLabel(summary.unresolvedErrorCount, "unresolved error"), "var(--chart-6, #ef4444)");
      }
      cardRoot.append(badges);
    }

    if (summary.tags.length > 0) {
      const row = element(document, "div", "lp-tag-row");
      for (const tag of summary.tags) {
        row.append(element(document, "span", "lp-tag", tag));
      }
      cardRoot.append(row);
    }

    cards.append(cardRoot);
  }

  function render(summaries: readonly PathSummary[], selectedPathId: string | null): void {
    if (disposed || signal.aborted) return;
    latestSummaries = summaries;
    clear();

    root.append(element(document, "h2", "lp-pane-title", "Paths overview"));

    const tags = distinctTags(summaries);
    const counts = tagCounts(summaries);
    const controls = element(document, "div", "lp-overview-controls");

    // A held filter survives a path losing its last instance of the tag: the
    // option stays listed so the empty result can be cleared, never hidden.
    const optionTags =
      filterTag !== null && !tags.some((tag) => tagMatches(tag, filterTag))
        ? [...tags, filterTag]
        : tags;
    if (optionTags.length > 0) {
      const field = element(document, "label", "lp-path-field");
      field.append(element(document, "span", "lp-field-label", "Group"));
      const filterSelect = element(document, "select", "lp-select lp-overview-filter");
      filterSelect.setAttribute("aria-label", "Filter paths by tag");
      const all = element(document, "option", undefined, `All paths (${summaries.length})`);
      all.value = "";
      filterSelect.append(all);
      for (const tag of optionTags) {
        const count = counts.get(tag.toLowerCase()) ?? 0;
        const option = element(document, "option", undefined, `${tag} (${count})`);
        option.value = tag;
        filterSelect.append(option);
      }
      if (filterTag !== null) {
        const option = [...filterSelect.options].find((candidate) => candidate.value === filterTag);
        if (option) option.selected = true;
      }
      filterSelect.addEventListener("change", () => {
        if (disposed || signal.aborted) return;
        const value = selectedValue(filterSelect);
        filterTag = value === "" ? null : value;
        render(latestSummaries, selectedPathId);
      });
      field.append(filterSelect);
      controls.append(field);
    }

    const sortField = element(document, "label", "lp-path-field");
    sortField.append(element(document, "span", "lp-field-label", "Sort"));
    const sortSelect = element(document, "select", "lp-select lp-overview-sort");
    sortSelect.setAttribute("aria-label", "Sort paths");
    for (const candidate of SORT_OPTIONS) {
      const option = element(document, "option", undefined, candidate.label);
      option.value = candidate.value;
      if (candidate.value === sortKey) option.selected = true;
      sortSelect.append(option);
    }
    sortSelect.addEventListener("change", () => {
      if (disposed || signal.aborted) return;
      const chosen = SORT_OPTIONS.find((candidate) => candidate.value === selectedValue(sortSelect));
      if (!chosen) return;
      sortKey = chosen.value;
      render(latestSummaries, selectedPathId);
    });
    sortField.append(sortSelect);
    controls.append(sortField);
    root.append(controls);

    const visible = inSortOrder(
      summaries.filter(
        (summary) => filterTag === null || summary.tags.some((tag) => tagMatches(tag, filterTag)),
      ),
      sortKey,
    );
    // The same filtered set drives the count and the grid, so the line can
    // never disagree with what is on screen.
    const countLine = element(
      document,
      "p",
      "lp-overview-count",
      filterTag === null
        ? countLabel(summaries.length, "path")
        : `${visible.length} of ${countLabel(summaries.length, "path")}`,
    );
    countLine.setAttribute("role", "status");
    root.append(countLine);

    const cards = element(document, "div", "lp-overview-cards");
    root.append(cards);
    if (visible.length === 0 && summaries.length > 0) {
      cards.append(
        element(document, "p", "lp-empty-state", "No paths carry this tag. Clear the group filter to see them all."),
      );
    }
    for (const summary of visible) {
      card(summary, summary.id === selectedPathId);
    }
  }

  return {
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}
