/** Path Hub view.
 *
 * One plugin view with four cooperating surfaces:
 * - a header bar with path switcher, Create a Path, Refine Path and progress;
 * - the path pane: a recorded-structure graph (module clusters, node cards and
 *   only `interleavesNodeIds` edges) with the module-lane roadmap as the
 *   alternate lens;
 * - the Architect chat pane (`mountStandardComposer` + `mountMarkdown`);
 * - the Node Inspector (pre-reading, artifact justification, progression and
 *   child-chat actions).
 *
 * Lifecycle: every widget, listener, timer-free async load and DOM node belongs
 * to the per-mount signal. Stale loads are fenced by a request token, and
 * `onNotification` / `onResync` re-read authoritative state instead of trusting
 * a notification payload as data.
 */
import type {
  PluginFrontendContext,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import type { ArtifactType, ChildSessionKind, LearningPath, PathNode, PivotSuggestion, ProgressionState } from "../domain.ts";
import { triggerBrowserDownload } from "../export.ts";
import type { ExportedLearningPath, ExportFormat } from "../export.ts";
import { createSessionLauncher } from "../session-launcher.ts";
import type { NativeSessionHost } from "../native-session-host.ts";
import { consumePathHubTarget, subscribePathHubTarget } from "../session-navigation.ts";
import type { SessionStatus } from "../session-types.ts";
import {
  ARTIFACT_TYPES,
  PROGRESSION_STATES,
  artifactCatalogEntry,
  formatSourceAnchor,
  recommendedArtifactsFor,
} from "../domain.ts";
import { EVENT_ARCHITECT_CHANGED, EVENT_PATHS_CHANGED } from "../topics.ts";
import { createArchitectPane } from "./architect-pane.ts";
import { createPathsOverview } from "./paths-overview.ts";
import { createNodeInspector } from "./node-inspector.ts";
import type { NodeInspectorChange } from "./node-inspector.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { pivotDiscussionPrompt } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";
import { openLinkExistingSessionDialog } from "./session-dialogs.ts";
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_LABELS,
  PROGRESSION_COLORS,
  PROGRESSION_LABELS,
  artifactLabel,
} from "./labels.ts";

/** The backend's `paths.list` projection; not a second full path payload.
 * Mirrored by the backend's own `summarize` and the test host: keep all three
 * in sync when a field is added. */
export interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: "canonical" | "uploaded";
  /** Spine titles for the overview card: canonical references or uploads. */
  readonly sourceTitles: readonly string[];
  /** Ungated node-state inventory: honest counts, never a completion target. */
  readonly nodeStates: Readonly<Record<ProgressionState, number>>;
  readonly pendingPivotCount: number;
  readonly unresolvedErrorCount: number;
  /** Learner-owned grouping tags; absent on old paths reads as none. */
  readonly tags: readonly string[];
  /** The path's one folder home, or null when unfiled. */
  readonly folder: string | null;
  readonly architectChatId?: string | null;
}

interface PathsListResult {
  readonly paths: readonly PathSummary[];
}

interface PathResult {
  readonly path: LearningPath | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Fallback card geometry for hosts without layout (tests) or before first
 * paint. Real browsers are measured; this keeps the edge layer deterministic. */
const FALLBACK_COLUMN_WIDTH = 320;
const FALLBACK_CARD_WIDTH = 280;
const FALLBACK_CARD_HEIGHT = 96;
const FALLBACK_CARD_GAP = 16;
const FALLBACK_HEADER_HEIGHT = 84;
const FALLBACK_PADDING = 12;

interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

interface NodePlacement {
  readonly moduleIndex: number;
  readonly nodeIndex: number;
}

interface CardBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly moduleIndex: number;
  readonly nodeIndex: number;
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

function nodeById(path: LearningPath, nodeId: string | null): PathNode | null {
  if (!nodeId) return null;
  for (const module of path.modules) {
    const node = module.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return null;
}

function countNodes(path: LearningPath): { total: number; consolidated: number; inProgress: number } {
  let total = 0;
  let consolidated = 0;
  let inProgress = 0;
  for (const module of path.modules) {
    for (const node of module.nodes) {
      total += 1;
      if (node.progression === "consolidated") consolidated += 1;
      if (node.progression === "in_progress") inProgress += 1;
    }
  }
  return { total, consolidated, inProgress };
}

/** Mount the Path Hub into a plugin view container and return its cleanup. */
export interface PathHubOptions {
  /** Test seam: inject the native session host so no network/storage is touched. */
  readonly sessionHost?: NativeSessionHost;
  /** Test seam: observe or replace the browser download for an export. */
  readonly onExport?: (exported: ExportedLearningPath) => void;
}

export function mountPathHub(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PathHubOptions = {},
): () => void {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-hub");
  container.append(root);

  const header = element(document, "header", "lp-header");
  const titleBlock = element(document, "div", "lp-title-block");
  const title = element(document, "h1", "lp-title", "Path Hub");
  const goal = element(document, "p", "lp-goal");
  titleBlock.append(title, goal);
  header.append(titleBlock);

  const headerActions = element(document, "div", "lp-header-actions");
  const pathLabel = element(document, "label", "lp-path-field");
  pathLabel.append(element(document, "span", "lp-field-label", "Learning path"));
  const pathSelect = element(document, "select", "lp-select lp-path-select");
  pathSelect.setAttribute("aria-label", "Learning path");
  pathLabel.append(pathSelect);
  headerActions.append(pathLabel);

  const createHost = element(document, "span", "lp-button-host");
  const refineHost = element(document, "span", "lp-button-host");
  const exportHost = element(document, "span", "lp-button-host");
  const viewHost = element(document, "span", "lp-button-host");
  headerActions.append(createHost, refineHost, exportHost, viewHost);
  const summary = element(document, "p", "lp-progress-summary");
  summary.setAttribute("aria-live", "polite");
  headerActions.append(summary);
  header.append(headerActions);
  root.append(header);

  const hubError = element(document, "p", "lp-hub-error");
  hubError.setAttribute("role", "alert");
  hubError.hidden = true;
  root.append(hubError);

  const body = element(document, "div", "lp-hub-body");
  const overviewContainer = element(document, "section", "lp-overview-pane");
  overviewContainer.setAttribute("aria-label", "Paths overview");
  root.append(overviewContainer);
  // The host tree widget is gone: this pane now holds the recorded-structure
  // graph (default) or the module-lane roadmap (alternate lens).
  const pathPane = element(document, "section", "lp-path-pane");
  pathPane.setAttribute("aria-label", "Path graph");
  const paneTitle = element(document, "h2", "lp-pane-title", "Path graph");
  pathPane.append(paneTitle);
  const graphHost = element(document, "div", "lp-graph-host");
  const roadmapHost = element(document, "div", "lp-roadmap-host");
  roadmapHost.hidden = true;
  const pathEmpty = element(
    document,
    "p",
    "lp-empty-state",
    "No learning paths yet. Use Create a Path to talk to the Architect.",
  );
  pathPane.append(graphHost, roadmapHost, pathEmpty);
  const architectContainer = element(document, "div", "lp-architect-pane");
  body.append(pathPane, architectContainer);
  root.append(body);

  // The detailed view floats above the hub instead of taking a grid column:
  // the path graph/roadmap pane and the Architect conversation keep full
  // width, and the inspector opens on node selection and closes on demand.
  const inspectorContainer = element(document, "aside", "lp-inspector-pane");
  inspectorContainer.setAttribute("aria-label", "Node details");
  inspectorContainer.hidden = true;
  const inspectorBar = element(document, "div", "lp-inspector-bar");
  inspectorBar.append(element(document, "span", "lp-inspector-bar-title", "Node details"));
  const inspectorCloseHost = element(document, "span", "lp-button-host");
  inspectorBar.append(inspectorCloseHost);
  inspectorContainer.append(inspectorBar);
  root.append(inspectorContainer);

  let summaries: PathSummary[] = [];
  let path: LearningPath | null = null;
  let selectedPathId: string | null = null;
  let selectedNodeId: string | null = null;
  let refineOpen = false;
  /** Path whose Architect conversation was last opened automatically. Background
   * refreshes for the same path never switch away from the conversation in view. */
  let autoLoadedPathId: string | null = null;
  /** A path the Architect just created; selected if the pane shows its conversation. */
  let createdPathId: string | null = null;
  let loadToken = 0;
  let disposed = false;
  let startingSession = false;
  /** The learner's lens over one path: recorded-structure graph or module lanes. */
  let viewMode: "graph" | "roadmap" = "graph";
  /** Badge handles owned by the current graph/roadmap render; cleared per render. */
  let cardHandles: PluginWidgetHandle<unknown>[] = [];
  /** Repositions the current graph edge layer after a host resize. */
  let edgeLayout: (() => void) | null = null;
  const chatStatuses = new Map<string, SessionStatus>();
  const handles: PluginWidgetHandle<unknown>[] = [];

  const pane = createArchitectPane(ctx, architectContainer, signal);
  const launcher = createSessionLauncher(ctx, { host: options.sessionHost });
  const inspector = createNodeInspector(ctx, inspectorContainer, signal, {
    openSession(chatId) {
      if (!signal.aborted && !disposed) ctx.app.openSession(chatId);
    },
    startSession(kind) {
      return startChildSession(kind);
    },
    linkExistingSession() {
      openLinkExisting();
    },
    unlinkSession(chatId) {
      return unlinkSession(chatId);
    },
    chatStatus: chatStatuses,
    selectNode(nodeId) {
      selectNode(nodeId);
    },
    updateNode(change) {
      return updateNode(change);
    },
    updateError(errorId, change) {
      return updateError(errorId, change);
    },
    decidePivot(pivotId, decision) {
      return decidePivot(pivotId, decision);
    },
    discussPivot(pivot, node) {
      return discussPivot(pivot, node);
    },
  });

  const overview = createPathsOverview(ctx, overviewContainer, signal, {
    selectPath(pathId) {
      if (pathId !== selectedPathId) void selectPath(pathId);
    },
    tagsChanged() {
      void refreshAll();
    },
  });

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;

  function showError(message: string | null): void {
    if (disposed || signal.aborted) return;
    hubError.textContent = message ?? "";
    hubError.hidden = message === null;
  }

  /** Paint selection on the existing cards instead of rebuilding the view, so
   * a keyboard-triggered selection keeps focus on its card. */
  function applySelection(): void {
    for (const card of root.querySelectorAll<HTMLElement>(".lp-node-card")) {
      const isSelected = selectedNodeId !== null && card.dataset.nodeId === selectedNodeId;
      const selectedClass = card.classList.contains("lp-graph-card")
        ? "lp-graph-card-selected"
        : "lp-roadmap-card-selected";
      card.classList.toggle("lp-node-card-selected", isSelected);
      card.classList.toggle(selectedClass, isSelected);
      card.setAttribute("aria-pressed", isSelected ? "true" : "false");
    }
  }

  function selectNode(nodeId: string | null): void {
    if (disposed || signal.aborted) return;
    selectedNodeId = nodeId;
    applySelection();
    renderInspector();
  }

  /** Dispose every card badge and both view hosts. Called on each render and on
   * mount teardown, so no badge handle or DOM outlives the data it showed. */
  function disposeCards(): void {
    for (const handle of cardHandles.reverse()) handle.dispose();
    cardHandles = [];
    edgeLayout = null;
    graphHost.replaceChildren();
    roadmapHost.replaceChildren();
  }

  /** One card pattern for both lenses: real button, badges, anchor, selection. */
  function nodeCard(node: PathNode, kind: "graph" | "roadmap"): HTMLElement {
    const card = document.createElement("button");
    card.setAttribute("type", "button");
    card.dataset.nodeId = node.id;
    const selected = node.id === selectedNodeId;
    const classes = ["lp-node-card", kind === "graph" ? "lp-graph-card" : "lp-roadmap-card"];
    if (selected) {
      classes.push(
        "lp-node-card-selected",
        kind === "graph" ? "lp-graph-card-selected" : "lp-roadmap-card-selected",
      );
    }
    card.className = classes.join(" ");
    card.setAttribute("aria-pressed", selected ? "true" : "false");
    card.append(element(document, "span", "lp-node-card-title", node.title));
    const badges = element(document, "span", "lp-badge-row lp-node-card-badges");
    card.append(badges);
    cardHandles.push(
      ctx.ui.mountBadge(
        badges,
        { text: NODE_TYPE_LABELS[node.type], color: NODE_TYPE_COLORS[node.type] },
        { signal },
      ),
    );
    cardHandles.push(
      ctx.ui.mountBadge(
        badges,
        { text: PROGRESSION_LABELS[node.progression], color: PROGRESSION_COLORS[node.progression] },
        { signal },
      ),
    );
    const unresolved = node.errors.filter((entry) => !entry.resolved).length;
    if (unresolved > 0) {
      cardHandles.push(
        ctx.ui.mountBadge(
          badges,
          { text: `${unresolved} unresolved`, color: "var(--chart-6, #ef4444)" },
          { signal },
        ),
      );
    }
    card.append(
      element(document, "span", "lp-node-card-anchor", formatSourceAnchor(node.sourceAnchor)),
    );
    if (node.childSessions.length > 0) {
      const teaching = node.childSessions.filter((chat) => chat.kind === "teaching").length;
      const practice = node.childSessions.length - teaching;
      const parts: string[] = [];
      if (teaching > 0) parts.push(`${teaching} teaching`);
      if (practice > 0) parts.push(`${practice} practice`);
      card.append(element(document, "span", "lp-muted", parts.join(" · ")));
    }
    card.addEventListener("click", () => {
      if (signal.aborted || disposed) return;
      selectNode(node.id);
    });
    return card;
  }

  /** Every recorded interleaving link, read in one direction: a node's
   * `interleavesNodeIds` lists the prior nodes it builds on. This is the only
   * edge source; the graph never infers a prerequisite. */
  function recordedEdges(pathValue: LearningPath): GraphEdge[] {
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const module of pathValue.modules) {
      for (const node of module.nodes) {
        for (const from of node.interleavesNodeIds) {
          if (from === node.id) continue;
          const key = `${from}\u0000${node.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from, to: node.id });
        }
      }
    }
    return edges;
  }

  const round = (value: number): string => String(Math.round(value * 10) / 10);

  function edgePath(from: CardBox, to: CardBox): string {
    if (from.moduleIndex === to.moduleIndex) {
      // Cards in one cluster are stacked: link the nearest horizontal edges.
      const downward = from.nodeIndex < to.nodeIndex;
      const startX = from.x + from.width / 2;
      const startY = downward ? from.y + from.height : from.y;
      const endX = to.x + to.width / 2;
      const endY = downward ? to.y : to.y + to.height;
      const bend = Math.max(18, Math.abs(endY - startY) / 2);
      const control1 = downward ? startY + bend : startY - bend;
      const control2 = downward ? endY - bend : endY + bend;
      return `M ${round(startX)} ${round(startY)} C ${round(startX)} ${round(control1)}, ${round(endX)} ${round(control2)}, ${round(endX)} ${round(endY)}`;
    }
    // Cards in different clusters are columns side by side.
    const forward = to.x >= from.x;
    const startX = forward ? from.x + from.width : from.x;
    const endX = forward ? to.x : to.x + to.width;
    const startY = from.y + from.height / 2;
    const endY = to.y + to.height / 2;
    const bend = Math.max(32, Math.abs(endX - startX) / 2);
    const control1 = startX + (forward ? bend : -bend);
    const control2 = endX - (forward ? bend : -bend);
    return `M ${round(startX)} ${round(startY)} C ${round(control1)} ${round(startY)}, ${round(control2)} ${round(endY)}, ${round(endX)} ${round(endY)}`;
  }

  /** A decorative SVG layer over the cards. Hidden from assistive tech: the
   * inspector's "Interleaved prior nodes" list is the accessible record. */
  function edgeLayer(
    board: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    placement: ReadonlyMap<string, NodePlacement>,
    edges: readonly GraphEdge[],
  ): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "lp-graph-edges");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("role", "presentation");
    const paths = edges.map((edge) => {
      const pathElement = document.createElementNS(SVG_NS, "path");
      pathElement.setAttribute("class", "lp-graph-edge");
      pathElement.setAttribute("data-edge-from", edge.from);
      pathElement.setAttribute("data-edge-to", edge.to);
      pathElement.setAttribute("data-from", edge.from);
      pathElement.setAttribute("data-to", edge.to);
      svg.append(pathElement);
      return pathElement;
    });

    const reposition = (): void => {
      if (disposed || signal.aborted) return;
      const boardRect = board.getBoundingClientRect();
      const boxes = new Map<string, CardBox>();
      let measured = boardRect.width > 0 && boardRect.height > 0;
      let maxRight = 0;
      let maxBottom = 0;
      for (const [nodeId, card] of cards) {
        const place = placement.get(nodeId);
        if (!place) continue;
        const rect = card.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) measured = false;
        const box: CardBox = {
          x: rect.left - boardRect.left,
          y: rect.top - boardRect.top,
          width: rect.width,
          height: rect.height,
          moduleIndex: place.moduleIndex,
          nodeIndex: place.nodeIndex,
        };
        boxes.set(nodeId, box);
        maxRight = Math.max(maxRight, box.x + box.width);
        maxBottom = Math.max(maxBottom, box.y + box.height);
      }

      let width = Math.max(boardRect.width, board.scrollWidth, maxRight + FALLBACK_PADDING);
      let height = Math.max(boardRect.height, board.scrollHeight, maxBottom + FALLBACK_PADDING);
      if (!measured) {
        // No layout engine (tests) or before first paint: deterministic columns.
        let moduleCount = 1;
        let rowCount = 1;
        for (const place of placement.values()) {
          moduleCount = Math.max(moduleCount, place.moduleIndex + 1);
          rowCount = Math.max(rowCount, place.nodeIndex + 1);
        }
        for (const [nodeId, place] of placement) {
          boxes.set(nodeId, {
            x: FALLBACK_PADDING + place.moduleIndex * FALLBACK_COLUMN_WIDTH,
            y: FALLBACK_HEADER_HEIGHT + place.nodeIndex * (FALLBACK_CARD_HEIGHT + FALLBACK_CARD_GAP),
            width: FALLBACK_CARD_WIDTH,
            height: FALLBACK_CARD_HEIGHT,
            moduleIndex: place.moduleIndex,
            nodeIndex: place.nodeIndex,
          });
        }
        width = FALLBACK_PADDING * 2 + moduleCount * FALLBACK_COLUMN_WIDTH;
        height =
          FALLBACK_HEADER_HEIGHT + rowCount * (FALLBACK_CARD_HEIGHT + FALLBACK_CARD_GAP) + FALLBACK_PADDING;
      }
      svg.setAttribute("width", String(Math.ceil(Math.max(1, width))));
      svg.setAttribute("height", String(Math.ceil(Math.max(1, height))));
      edges.forEach((edge, index) => {
        const pathElement = paths[index];
        const from = boxes.get(edge.from);
        const to = boxes.get(edge.to);
        if (!pathElement || !from || !to) return;
        pathElement.setAttribute("d", edgePath(from, to));
      });
    };

    edgeLayout = reposition;
    reposition();
    const view = document.defaultView;
    if (view && typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        if (edgeLayout === reposition) reposition();
      });
    }
    return svg;
  }

  /** Modules are clusters (columns), nodes are buttons, and the only lines are
   * the recorded interleaving links. Order follows the record; nothing moves on
   * its own. */
  function buildGraph(): void {
    if (!path) return;
    const board = element(document, "div", "lp-graph");
    const cards = new Map<string, HTMLElement>();
    const placement = new Map<string, NodePlacement>();
    path.modules.forEach((module, moduleIndex) => {
      const cluster = element(document, "section", "lp-graph-cluster");
      cluster.setAttribute("aria-label", module.title);
      const clusterHeader = element(document, "div", "lp-graph-cluster-header");
      clusterHeader.append(element(document, "h3", "lp-graph-cluster-title", module.title));
      if (module.goal !== undefined) {
        clusterHeader.append(element(document, "p", "lp-graph-cluster-goal", module.goal));
      }
      const consolidated = module.nodes.filter((node) => node.progression === "consolidated").length;
      clusterHeader.append(
        element(document, "span", "lp-muted", `${consolidated}/${module.nodes.length} consolidated`),
      );
      cluster.append(clusterHeader);
      const cardList = element(document, "div", "lp-graph-cards");
      module.nodes.forEach((node, nodeIndex) => {
        const card = nodeCard(node, "graph");
        card.dataset.moduleIndex = String(moduleIndex);
        cards.set(node.id, card);
        placement.set(node.id, { moduleIndex, nodeIndex });
        cardList.append(card);
      });
      cluster.append(cardList);
      board.append(cluster);
    });
    graphHost.append(board);
    const edges = recordedEdges(path).filter(
      (edge) => cards.has(edge.from) && cards.has(edge.to),
    );
    if (edges.length > 0) {
      board.append(edgeLayer(board, cards, placement, edges));
    }
  }

  /** Module lanes with node cards: the alternate flat lens over the same record.
   * No arrows, no dates, no order pressure. */
  function buildRoadmap(): void {
    if (!path) return;
    const board = element(document, "div", "lp-roadmap");
    for (const module of path.modules) {
      const lane = element(document, "section", "lp-lane");
      lane.setAttribute("aria-label", module.title);
      const laneHeader = element(document, "div", "lp-lane-header");
      laneHeader.append(element(document, "h3", "lp-lane-title", module.title));
      if (module.goal !== undefined) {
        laneHeader.append(element(document, "p", "lp-lane-goal", module.goal));
      }
      const consolidated = module.nodes.filter((node) => node.progression === "consolidated").length;
      laneHeader.append(
        element(document, "span", "lp-muted", `${consolidated}/${module.nodes.length} consolidated`),
      );
      lane.append(laneHeader);
      const cards = element(document, "div", "lp-lane-cards");
      for (const node of module.nodes) {
        cards.append(nodeCard(node, "roadmap"));
      }
      lane.append(cards);
      board.append(lane);
    }
    roadmapHost.append(board);
  }

  function renderPathView(): void {
    if (disposed || signal.aborted) return;
    const roadmap = viewMode === "roadmap" && path !== null && path.modules.length >= 2;
    paneTitle.textContent = roadmap ? "Path roadmap" : "Path graph";
    pathPane.setAttribute("aria-label", roadmap ? "Path roadmap" : "Path graph");
    pathEmpty.hidden = path !== null;
    graphHost.hidden = path === null || roadmap;
    roadmapHost.hidden = path === null || !roadmap;
    disposeCards();
    if (path === null) return;
    if (roadmap) buildRoadmap();
    else buildGraph();
  }

  function renderInspector(): void {
    if (disposed || signal.aborted) return;
    const node = path ? nodeById(path, selectedNodeId) : null;
    inspectorContainer.hidden = node === null;
    inspector.render(path, node);
  }

  function renderHeader(): void {
    if (disposed || signal.aborted) return;
    pathSelect.replaceChildren();
    for (const summaryItem of summaries) {
      const option = element(document, "option", undefined, summaryItem.title);
      option.value = summaryItem.id;
      if (summaryItem.id === selectedPathId) option.selected = true;
      pathSelect.append(option);
    }
    pathSelect.disabled = summaries.length === 0;

    goal.textContent = path?.goal ?? "Create a path, then follow its modules, nodes and child chats.";

    if (path) {
      const { total, consolidated, inProgress } = countNodes(path);
      summary.textContent = `${consolidated} of ${total} nodes consolidated · ${inProgress} in progress`;
      summary.dataset.total = String(total);
      summary.dataset.consolidated = String(consolidated);
      summary.dataset.inProgress = String(inProgress);
    } else {
      summary.textContent = "No path selected";
      delete summary.dataset.total;
      delete summary.dataset.consolidated;
      delete summary.dataset.inProgress;
    }

    createButton.update({ disabled: false });
    refineButton.update({
      label: refineOpen ? "Refine Path · on" : "Refine Path",
      variant: refineOpen ? "secondary" : "outline",
    });
    exportButton.update({ disabled: path === null });
    const multiModule = path !== null && path.modules.length >= 2;
    viewHost.hidden = !multiModule;
    viewModeButton.update({
      label: viewMode === "graph" ? "Roadmap view" : "Graph view",
      variant: viewMode === "graph" ? "outline" : "secondary",
    });
    // Keep the Architect visible while there is no path yet: that is how one is made.
    architectContainer.hidden = !refineOpen && summaries.length > 0;
  }

  function renderAll(): void {
    if (disposed || signal.aborted) return;
    renderHeader();
    // The overview is the dashboard over existing paths; an empty hub keeps a
    // single empty state (the path pane's) instead of two identical messages.
    overviewContainer.hidden = summaries.length === 0;
    overview.render(summaries, selectedPathId);
    renderPathView();
    renderInspector();
  }

  function ensureSelection(): void {
    if (!path) {
      selectedNodeId = null;
      return;
    }
    if (!nodeById(path, selectedNodeId)) {
      selectedNodeId = path.modules[0]?.nodes[0]?.id ?? null;
    }
  }

  async function refreshChatStatuses(token: number, pathId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      const result = await ctx.call<{ sessions: readonly SessionStatus[] }>(
        "sessions.status",
        { pathId },
      );
      if (!live(token)) return;
      chatStatuses.clear();
      for (const session of result.sessions ?? []) chatStatuses.set(session.chatId, session);
    } catch {
      // Missing status is not fatal: links still render, and tools re-check existence.
      if (live(token)) chatStatuses.clear();
    }
  }

  async function refreshAll(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    // A top-bar navigation may have arrived before this mount finished loading.
    const target = consumePathHubTarget();
    if (target) {
      selectedPathId = target.pathId;
      selectedNodeId = target.nodeId;
    }
    try {
      const listed = await ctx.call<PathsListResult>("paths.list");
      if (!live(token)) return;
      summaries = [...(listed.paths ?? [])];
      if (createdPathId) {
        const created = summaries.find((entry) => entry.id === createdPathId);
        createdPathId = null;
        if (created?.architectChatId && created.architectChatId === pane.conversationId()) {
          selectedPathId = created.id;
          selectedNodeId = null;
        }
      }
      if (!selectedPathId || !summaries.some((entry) => entry.id === selectedPathId)) {
        selectedPathId = summaries[0]?.id ?? null;
        if (target) selectedNodeId = null;
      }
      let loaded: LearningPath | null = null;
      if (selectedPathId) {
        const result = await ctx.call<PathResult>("paths.get", { id: selectedPathId });
        if (!live(token)) return;
        loaded = result.path;
      }
      path = loaded;
      if (path) {
        await refreshChatStatuses(token, path.id);
        if (!live(token)) return;
      } else {
        chatStatuses.clear();
      }
      ensureSelection();
      showError(null);
      renderAll();

      if (path?.architectChatId && !pane.isNewDraft() && path.id !== autoLoadedPathId) {
        autoLoadedPathId = path.id;
        if (pane.conversationId() !== path.architectChatId) {
          await pane.load(path.architectChatId);
        }
      }
    } catch (problem) {
      if (!live(token)) return;
      showError(`Could not load learning paths: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  async function selectPath(pathId: string): Promise<void> {
    if (disposed || signal.aborted || pathId === selectedPathId) return;
    selectedPathId = pathId;
    selectedNodeId = null;
    await refreshAll();
    // An explicit path selection takes precedence over an unsent new-path draft.
    if (path?.id === pathId && path.architectChatId && pane.isNewDraft()) {
      autoLoadedPathId = path.id;
      await pane.load(path.architectChatId);
    }
  }

  async function updateNode(change: NodeInspectorChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<PathResult & { path: LearningPath }>("paths.updateNode", {
        pathId: path.id,
        nodeId: selectedNodeId,
        ...change,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not save the node change: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  async function updateError(errorId: string, change: ErrorLedgerChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<PathResult & { path: LearningPath }>("errors.update", {
        pathId: path.id,
        nodeId: selectedNodeId,
        errorId,
        ...change,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not update the error ledger: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  async function decidePivot(pivotId: string, decision: PivotDecision): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<{
        path: LearningPath;
        insertedNode: PathNode | null;
        changed: boolean;
      }>("pivots.resolve", {
        pathId: path.id,
        nodeId: selectedNodeId,
        pivotId,
        action: decision,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      if (decision === "accept" && result.insertedNode) {
        // Show the inserted repair node so its anchor and goal are visible.
        selectedNodeId = result.insertedNode.id;
      }
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not ${decision} the pivot: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  async function discussPivot(pivot: PivotSuggestion, node: PathNode): Promise<void> {
    if (disposed || signal.aborted) return;
    refineOpen = true;
    renderHeader();
    // A pivot belongs to this path: discuss it in the path's own Architect
    // conversation, not in an unsent new-path draft or another path's chat.
    if (path?.architectChatId && pane.conversationId() !== path.architectChatId) {
      await pane.load(path.architectChatId);
      if (disposed || signal.aborted) return;
    }
    await pane.discuss(pivotDiscussionPrompt(pivot, node));
  }

  async function startChildSession(kind: ChildSessionKind): Promise<void> {
    if (disposed || signal.aborted || startingSession || !path || !selectedNodeId) return;
    startingSession = true;
    try {
      await launcher.start({ pathId: path.id, nodeId: selectedNodeId, kind });
      if (disposed || signal.aborted) return;
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not start the ${kind} chat: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    } finally {
      startingSession = false;
    }
  }

  function openLinkExisting(): void {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const node = nodeById(path, selectedNodeId);
    if (!node) return;
    openLinkExistingSessionDialog(ctx, {
      launcher,
      pathId: path.id,
      nodeId: node.id,
      nodeTitle: node.title,
      signal,
      onLinked() {
        void refreshAll();
      },
    });
  }

  async function unlinkSession(chatId: string): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<{ path: LearningPath }>("sessions.unlink", {
        pathId: path.id,
        nodeId: selectedNodeId,
        chatId,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      await refreshChatStatuses(loadToken, path.id);
      if (disposed || signal.aborted) return;
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not unlink the chat: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  async function exportCurrentPath(format: ExportFormat): Promise<void> {
    if (disposed || signal.aborted || path === null) return;
    try {
      const exported = await ctx.call<ExportedLearningPath>("paths.export", {
        pathId: path.id,
        format,
      });
      if (disposed || signal.aborted) return;
      (options.onExport ?? ((item) => triggerBrowserDownload(document, item)))(exported);
      showError(null);
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not export the learning path: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  const createButton = ctx.ui.mountButton(
    createHost,
    {
      label: "Create a Path",
      variant: "default",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed) return;
        refineOpen = true;
        renderHeader();
        pane.startNew();
      },
    },
    { signal },
  );
  handles.push(createButton);

  const refineButton = ctx.ui.mountButton(
    refineHost,
    {
      label: "Refine Path",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed) return;
        refineOpen = !refineOpen;
        renderHeader();
        if (!refineOpen) return;
        // Refine Path always means the selected path's conversation, even over an unsent draft.
        if (path?.architectChatId) {
          if (pane.conversationId() !== path.architectChatId) void pane.load(path.architectChatId);
        } else if (!pane.conversationId()) {
          pane.startNew();
        }
      },
    },
    { signal },
  );
  handles.push(refineButton);

  const exportButton = ctx.ui.mountButton(
    exportHost,
    {
      label: "Export Path",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed || path === null) return;
        const handle = ctx.ui.openMenu(
          exportHost,
          {
            label: "Export learning path",
            preferredSide: "down",
            items: [
              {
                key: "export-json",
                label: "Export as JSON",
                onSelect: () => void exportCurrentPath("json"),
              },
              {
                key: "export-markdown",
                label: "Export as Markdown",
                onSelect: () => void exportCurrentPath("markdown"),
              },
            ],
          },
          { signal },
        );
        handles.push(handle);
      },
    },
    { signal },
  );
  handles.push(exportButton);

  const inspectorCloseButton = ctx.ui.mountButton(
    inspectorCloseHost,
    {
      label: "Close",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        if (signal.aborted || disposed) return;
        selectNode(null);
      },
    },
    { signal },
  );
  handles.push(inspectorCloseButton);

  const viewModeButton = ctx.ui.mountButton(
    viewHost,
    {
      label: "Roadmap view",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed) return;
        viewMode = viewMode === "graph" ? "roadmap" : "graph";
        renderHeader();
        renderPathView();
      },
    },
    { signal },
  );
  handles.push(viewModeButton);

  pathSelect.addEventListener("change", () => {
    if (signal.aborted || disposed) return;
    void selectPath(pathSelect.value);
  });

  const offNotification = ctx.onNotification((event) => {
    if (signal.aborted || disposed) return;
    if (event.topic === EVENT_PATHS_CHANGED) {
      const data = event.data as { id?: unknown; created?: unknown } | undefined;
      if (data?.created === true && typeof data.id === "string") createdPathId = data.id;
      void refreshAll();
      return;
    }
    if (event.topic === EVENT_ARCHITECT_CHANGED) {
      const data = event.data as { id?: unknown; messageCount?: unknown } | undefined;
      const id = typeof data?.id === "string" ? data.id : null;
      const messageCount = typeof data?.messageCount === "number" ? data.messageCount : undefined;
      if (id && id === pane.conversationId()) void pane.refresh(id, messageCount);
    }
  });

  const offNavigation = subscribePathHubTarget((target) => {
    if (signal.aborted || disposed) return;
    consumePathHubTarget();
    if (path?.id === target.pathId) {
      selectedPathId = target.pathId;
      selectedNodeId = target.nodeId;
      renderAll();
      return;
    }
    selectedPathId = target.pathId;
    selectedNodeId = target.nodeId;
    void refreshAll();
  });

  const offResync = ctx.onResync(() => {
    if (signal.aborted || disposed) return;
    void refreshAll();
    const id = pane.conversationId();
    if (id) void pane.load(id);
  });

  const onViewResize = (): void => {
    if (!disposed && !signal.aborted) edgeLayout?.();
  };
  const defaultView = document.defaultView;
  if (defaultView) defaultView.addEventListener("resize", onViewResize);

  const onAbort = (): void => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offNavigation();
    offResync();
    if (defaultView) defaultView.removeEventListener("resize", onViewResize);
    for (const handle of handles.reverse()) handle.dispose();
    handles.length = 0;
    disposeCards();
    inspector.dispose();
    overview.dispose();
    pane.dispose();
    root.remove();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  void refreshAll();

  return () => {
    signal.removeEventListener("abort", onAbort);
    onAbort();
  };
}

/** Exported for the inspector and tests: every artifact the UI can persist. */
export const PATH_HUB_ARTIFACTS: readonly ArtifactType[] = ARTIFACT_TYPES;

/** Exported for tests and future slices: the three ungated progression states. */
export const PATH_HUB_PROGRESSIONS: readonly ProgressionState[] = PROGRESSION_STATES;

/** Human-readable artifact label (kept beside the tree so both panes agree). */
export function describeArtifact(type: ArtifactType): string {
  return `${artifactLabel(type)}: ${artifactCatalogEntry(type).justification}`;
}

/** The framework's first recommendation for a node type, for inline hints. */
export function firstRecommendedArtifact(node: PathNode): ArtifactType {
  return recommendedArtifactsFor(node.type)[0] ?? "none";
}
