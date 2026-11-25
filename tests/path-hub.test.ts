/** Path Hub frontend tests.
 *
 * Public-API test double only: the real view is mounted against a recorded host
 * UI and an in-memory JSON backend. These tests prove disposal, roadmap
 * rendering and navigation, Architect chat state, document-conversion failures and
 * `onResync` recovery without a browser or a model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSnapshot } from "learnharness-plugin-api";
import { mountPathHub } from "../src/view/path-hub.ts";
import { effectiveArtifact } from "../src/view/node-inspector.ts";
import { ARTIFACT_CATALOG } from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation, roadmapCard, selectRoadmapCard, setSelect } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function assistant(text: string): PluginAgentSnapshot["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as PluginAgentSnapshot["messages"][number];
}

function user(text: string): PluginAgentSnapshot["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() };
}

function snapshot(id: string, overrides: Partial<PluginAgentSnapshot> = {}): PluginAgentSnapshot {
  return makeConversation(id, overrides);
}

function liveButtons(fixture: ViewFixture): MountRecord[] {
  return fixture.all("mountButton");
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

test("Path Hub mounts every surface and disposes widgets, roadmap cards and listeners on unmount", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("Here is a plan.")] })],
  });
  try {
    const container = await mounted(fixture);

    assert.equal(fixture.all("mountTree").length, 0, "the host tree widget is gone from the Path Hub");
    assert.equal(
      container.querySelector<HTMLElement>(".lp-path-pane .lp-pane-title")!.textContent,
      "Path roadmap",
      "the roadmap is the path pane's lens, not a tree",
    );
    const lanes = container.querySelectorAll<HTMLElement>(".lp-lane");
    assert.equal(lanes.length, 2, "makePath()'s two modules are lanes");
    const cards = container.querySelectorAll<HTMLElement>(".lp-roadmap-card");
    assert.equal(cards.length, 6, "every node is a card");
    assert.ok(
      [...cards].every((card) => card.tagName === "BUTTON" && card.getAttribute("type") === "button"),
      "cards are real, keyboard-focusable buttons",
    );
    assert.equal(fixture.all("mountStandardComposer").length, 1);
    assert.equal(fixture.all("mountMarkdown").length, 1, "the stored Architect turn is rendered as Markdown");
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Create a Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Refine Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Upload PDF or text"));
    assert.ok(fixture.all("mountBadge").length >= 12, "node type and progression badges mount inside the cards");
    assert.match(container.textContent ?? "", /1 of 6 nodes consolidated/);

    const callsBefore = fixture.calls.length;
    fixture.controller.abort();
    await fixture.flush();

    assert.equal(container.childElementCount, 0, "the view root removes itself");
    assert.ok(fixture.records.length > 0);
    assert.ok(
      fixture.records.every((record) => record.disposed >= 1),
      "every ctx.ui handle, including card badges, is disposed exactly through its signal",
    );

    fixture.emit("paths-changed", { id: path.id });
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsBefore, "aborted listeners stop refetching");
  } finally {
    fixture.restore();
  }
});

test("roadmap renders module lanes and node cards with badges and preserves selection across updates", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const lanes = [...fixture.root.querySelectorAll<HTMLElement>(".lp-lane")];
    assert.deepEqual(
      lanes.map((lane) => lane.querySelector(".lp-lane-title")?.textContent),
      ["Structure first", "Synthesis"],
    );
    assert.match(lanes[0]!.textContent ?? "", /1\/3 consolidated/);
    assert.match(lanes[1]!.textContent ?? "", /0\/3 consolidated/);
    assert.deepEqual(
      [...fixture.root.querySelectorAll<HTMLElement>(".lp-roadmap-card")].map(
        (card) => card.dataset.nodeId,
      ),
      ["n-holistic", "n-concept", "n-skill", "n-contrast", "n-checkpoint", "n-bridge"],
    );
    assert.match(
      roadmapCard(fixture.root, "n-concept").textContent ?? "",
      /1 teaching/,
      "child chats are counted on the card where they are linked",
    );
    assert.deepEqual(
      fixture
        .all("mountBadge")
        // Card badges mount into `lp-badge-row` hosts; overview and inspector
        // badges use `lp-badge-host`, so this scopes the assertion.
        .filter((badge) => badge.container.closest(".lp-roadmap-card") !== null)
        .slice(0, 6)
        .map((badge) => badge.props.text),
      ["Holistic", "Consolidated", "Concept", "In progress", "Skill", "Unstarted"],
    );

    const initialArchitectCalls = fixture.calls.filter((call) => call.name.startsWith("architect")).length;
    const conceptCard = selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    const inspector = fixture.root.querySelector<HTMLElement>(".lp-inspector")!;
    assert.equal(inspector.dataset.nodeId, "n-concept");
    assert.match(inspector.textContent ?? "", /Understand n-concept from first principles\./);
    assert.match(inspector.textContent ?? "", /OSTEP — chapter 26, section 27\.1, pages 301-320/);
    assert.match(inspector.textContent ?? "", /Skim the module overview and the running example\./);
    assert.match(inspector.textContent ?? "", /Why the framework recommends this/);
    assert.match(inspector.textContent ?? "", /Eliminates hand-waving/);
    assert.equal(
      inspector.querySelector<HTMLSelectElement>('select[aria-label="Artifact type"]')!.value,
      "micro_code",
    );

    assert.equal(
      roadmapCard(fixture.root, "n-concept").getAttribute("aria-pressed"),
      "true",
      "the selected card is marked",
    );
    assert.match(roadmapCard(fixture.root, "n-concept").className, /lp-roadmap-card-selected/);
    assert.equal(
      roadmapCard(fixture.root, "n-concept"),
      conceptCard,
      "selection repaints in place, so keyboard focus stays on the card",
    );

    const interleaved = liveButtons(fixture).find((button) => button.props.label === "Node n-holistic");
    assert.ok(interleaved, "interleaved prior nodes are followable links");
    await interleaved.props.onClick();
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId, "n-holistic");
    assert.equal(roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"), "true");
    assert.equal(roadmapCard(fixture.root, "n-concept").getAttribute("aria-pressed"), "false");

    // A path refresh rebuilds the cards; the selection belongs to the hub, not
    // to the DOM, so it survives the re-render with the inspector intact.
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.equal(
      roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"),
      "true",
      "selection survives a roadmap re-render",
    );
    assert.equal(
      fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId,
      "n-holistic",
      "re-rendering the roadmap never clears the inspector selection",
    );

    // Child chats stay openable from the inspector that the card selected into.
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await liveButtons(fixture).find((button) => button.props.label === "Actions")!.props.onClick();
    const menu = fixture.find("openMenu");
    assert.equal(menu.props.label, "Session actions for First teaching chat");
    const open = menu.props.items.find((item: { key: string }) => item.key === "open");
    assert.ok(open, "a linked child chat exposes a navigation action in the inspector");
    await open.onSelect();
    assert.deepEqual(fixture.openedSessions, ["chat-1"]);
    assert.equal(
      fixture.calls.filter((call) => call.name.startsWith("architect")).length,
      initialArchitectCalls,
      "roadmap navigation never refetches or restarts the Architect",
    );
  } finally {
    fixture.restore();
  }
});

test("node inspector persists progression and artifact choices and refreshes badges and progress", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");

    const progression = fixture.root.querySelector<HTMLSelectElement>('select[aria-label="Progression"]')!;
    setSelect(progression, "consolidated");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      progression: "consolidated",
    });
    assert.match(fixture.root.textContent ?? "", /2 of 6 nodes consolidated · 1 in progress/);
    assert.ok(
      fixture
        .all("mountBadge")
        .some(
          (badge) =>
            badge.props.text === "Consolidated" &&
            badge.container.closest(".lp-roadmap-card")?.getAttribute("aria-pressed") === "true",
        ),
      "the selected card's progression badge updates with the record",
    );

    const artifact = fixture.root.querySelector<HTMLSelectElement>('select[aria-label="Artifact type"]')!;
    setSelect(artifact, "relational_map");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      artifactType: "relational_map",
    });
    const updated = fixture.paths.get(path.id)!;
    const node = updated.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!;
    assert.equal(effectiveArtifact(updated, node), "relational_map");
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-artifact-justification")!.textContent ?? "",
      /Externalizes mental structure/,
    );

    // Clearing the override falls back to the path default and keeps the card justified.
    setSelect(artifact, "");
    await fixture.flush();
    const afterClear = fixture.paths.get(path.id)!;
    assert.equal(
      afterClear.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!.artifactConfig,
      null,
    );
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-artifact-justification")!.textContent ?? "",
      /Crystallizes atomic hooks/,
      "the path default (retrieval cue) now supplies the justification",
    );
    assert.equal(ARTIFACT_CATALOG.length, 6);
  } finally {
    fixture.restore();
  }
});

test("Architect chat sends, shows busy state and adopts notification snapshots as Markdown turns", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [
      snapshot("chat-architect", { messages: [user("Build me a linear algebra path."), assistant("Here is a plan.")] }),
    ],
  });
  try {
    await mounted(fixture);
    assert.equal(fixture.all("mountMarkdown").length, 1);
    assert.equal(fixture.find("mountMarkdown").props.text, "Here is a plan.");

    const composer = fixture.find("mountStandardComposer");
    assert.equal(composer.props.composer.value, "");
    assert.equal(composer.props.composer.busy, false);
    assert.equal(typeof composer.props.composer.onStop, "function");
    assert.equal(typeof composer.props.dictation.onTranscript, "function");

    await composer.props.composer.onChange("Refine module two.");
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "Refine module two.");

    await composer.props.composer.onSend();
    await fixture.flush();
    const send = fixture.calls.filter((call) => call.name === "architect.send").at(-1);
    assert.ok(send);
    assert.deepEqual(
      { id: (send.input as { id: string }).id, text: (send.input as { text: string }).text },
      { id: "chat-architect", text: "Refine module two." },
    );
    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, true);
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-architect-status")!.textContent ?? "",
      /Architect is thinking/,
    );

    const updated = structuredClone(fixture.conversations.get("chat-architect")!);
    updated.status = "idle";
    updated.messages = [...updated.messages, assistant("Module two now has a contrast node.")];
    fixture.conversations.set("chat-architect", updated);
    fixture.emit("architect-changed", { id: "chat-architect", kind: "state", status: "idle" });
    await fixture.flush();

    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, false);
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Module two now has a contrast node."),
    );
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "");

    // Create a Path starts a fresh Architect conversation and opens the refine surface.
    const create = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await create.props.onClick();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0,
      "opening the composer must leave time to select a model before creating a conversation");
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false);
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false,
      "a path refresh must not replace the new model-selection draft with the old chat");
    assert.ok(
      liveButtons(fixture).some((button) => button.props.label === "Refine Path · on"),
      "Create a Path opens the Architect surface",
    );
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect-pane")!.hidden, false);
  } finally {
    fixture.restore();
  }
});

test("a new path chooses its Architect model before the conversation is created", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    const composer = fixture.find("mountStandardComposer");
    assert.match(fixture.root.querySelector(".lp-model-hint")?.textContent ?? "", /configured default/);
    await composer.props.model.onChange({ provider: "custom", id: "chosen-architect" });
    assert.equal(composer.props.thinking.value, undefined);
    await composer.props.thinking.onChange("high");
    await composer.props.model.onChange({ provider: "custom", id: "another-model" });
    assert.equal(composer.props.thinking.value, undefined, "changing models clears incompatible thinking");
    await composer.props.model.onChange({ provider: "custom", id: "chosen-architect" });
    await composer.props.thinking.onChange("high");
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    assert.deepEqual(composer.props.model.value, { provider: "custom", id: "chosen-architect" },
      "opening an already-empty draft does not discard a model choice");
    await composer.props.composer.onChange("Teach me geometry");
    await composer.props.composer.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.deepEqual((created?.input as { model: unknown }).model,
      { provider: "custom", id: "chosen-architect", thinkingLevel: "high" });
    assert.ok(fixture.calls.some((call) => call.name === "architect.send"));
    assert.equal(composer.props.model.disabled, true, "the model is fixed for this conversation");
    await composer.props.composer.onStop();
    await fixture.flush();
    const newPath = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await newPath.props.onClick();
    assert.equal(composer.props.model.disabled, false);
    assert.equal(composer.props.model.value, undefined);
    assert.equal(composer.props.thinking.value, undefined);
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 1);
  } finally {
    fixture.restore();
  }
});

test("Architect shows streamed reasoning and tool activity while a path is being built", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect", { status: "running" })] });
  try {
    await mounted(fixture);
    const progress = structuredClone(fixture.conversations.get("chat-architect")!);
    progress.partial = { role: "assistant", content: [
      { type: "thinking", thinking: "Map the chapter headings to the concepts." },
      { type: "toolCall", name: "read_uploaded_source_chunk", id: "call-1", arguments: {} },
      { type: "text", text: "Drafting the outline…" },
    ] } as unknown as PluginAgentSnapshot["partial"];
    fixture.conversations.set("chat-architect", progress);
    fixture.emit("architect-changed", { id: "chat-architect" });
    await fixture.flush();
    assert.match(fixture.root.querySelector(".lp-chat-reasoning")?.textContent ?? "", /Map the chapter headings/);
    assert.match(fixture.root.querySelector(".lp-chat-activity")?.textContent ?? "", /read_uploaded_source_chunk/);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Drafting the outline…"));
  } finally {
    fixture.restore();
  }
});

test("background refreshes keep the conversation in view and select the path it creates", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    const composer = fixture.find("mountStandardComposer");
    await composer.props.composer.onChange("Teach me shaders");
    await composer.props.composer.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.ok(created);
    const newChat = [...fixture.conversations.keys()].find((id) => id !== "chat-architect")!;
    const loads = () => fixture.calls.filter((call) => call.name === "architect.get" &&
      (call.input as { id: string }).id === "chat-architect").length;
    const before = loads();

    // Child-chat progress on the selected path must not switch the pane back.
    fixture.emit("paths-changed", { id: "path-linear-algebra" });
    await fixture.flush();
    assert.equal(loads(), before, "the running new conversation stays in view");

    // The new conversation saves its path: the hub selects it.
    const shaders = { ...makePath(), id: "path-shaders", title: "Shaders", architectChatId: newChat };
    fixture.paths.set(shaders.id, shaders);
    fixture.emit("paths-changed", { id: shaders.id, created: true });
    await fixture.flush();
    assert.equal(loads(), before);
    assert.equal(fixture.root.querySelector<HTMLSelectElement>("select")?.value, "path-shaders");
  } finally {
    fixture.restore();
  }
});

test("Refine Path over an unsent draft opens the selected path's conversation", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false, "a new draft is open");
    const refine = () => liveButtons(fixture).find((button) => String(button.props.label).startsWith("Refine Path"))!;
    await refine().props.onClick(); // close
    await refine().props.onClick(); // reopen for the selected path
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, true,
      "the path's existing conversation replaced the draft");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0);
  } finally {
    fixture.restore();
  }
});

test("streamed progress re-renders only the live turn, not the committed history", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect", {
      status: "running",
      messages: [user("Build a path"), assistant("First outline."), assistant("Second outline.")],
    })],
  });
  try {
    await mounted(fixture);
    const historyMounts = () => fixture.all("mountMarkdown").filter((mount) =>
      mount.props.text === "First outline." || mount.props.text === "Second outline.").length;
    const initial = historyMounts();
    assert.equal(initial, 2);
    const fullReads = () => fixture.calls.filter((call) => call.name === "architect.get").length;
    const readsBefore = fullReads();
    for (const text of ["Draft…", "Draft, more…"]) {
      const progress = structuredClone(fixture.conversations.get("chat-architect")!);
      progress.partial = { role: "assistant", content: [{ type: "text", text }] } as unknown as PluginAgentSnapshot["partial"];
      fixture.conversations.set("chat-architect", progress);
      fixture.emit("architect-changed", { id: "chat-architect", messageCount: 3, partial: true });
      await fixture.flush();
    }
    assert.equal(historyMounts(), initial, "history markdown is not remounted per progress tick");
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Draft, more…"));
    assert.equal(fullReads(), readsBefore, "progress ticks never refetch the committed history");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.progress").length, 2);

    // A committed message changes the count: the full conversation is reloaded.
    const committed = structuredClone(fixture.conversations.get("chat-architect")!);
    committed.messages = [...committed.messages, assistant("Third outline.")];
    delete committed.partial;
    committed.status = "idle";
    fixture.conversations.set("chat-architect", committed);
    fixture.emit("architect-changed", { id: "chat-architect", messageCount: 4, partial: false });
    await fixture.flush();
    assert.equal(fullReads(), readsBefore + 1);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Third outline."));
    assert.ok(!fixture.root.querySelector(".lp-chat-partial"), "the finished partial is gone");
  } finally {
    fixture.restore();
  }
});

test("document upload surfaces conversion errors without saving and saves on success", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    const input = fixture.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(input, "the Architect surface owns a native file picker");
    const file = new File(["not text"], "broken.pdf", { type: "application/pdf" });

    fixture.toMarkdown = async () => {
      throw new Error("Only UTF-8 text or a valid PDF can be converted.");
    };
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => file } });
    fire(input, "change");
    await fixture.flush();

    const status = () => fixture.root.querySelector<HTMLElement>(".lp-upload-status")!;
    assert.equal(status().dataset.state, "error");
    assert.match(status().textContent ?? "", /Could not use broken\.pdf/);
    assert.match(status().textContent ?? "", /Only UTF-8 text or a valid PDF/);
    assert.equal(fixture.uploaded.length, 0, "a failed conversion never reaches sources.save");
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 0);
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "", "the draft is untouched");

    const good = new File(["# Book"], "book.md", { type: "text/markdown" });
    fixture.toMarkdown = async () => ({
      name: "book.md",
      markdown: "# Book\n\nConverted content.",
      notices: ["Page 2 was image-only and was skipped."],
    });
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => good } });
    fire(input, "change");
    await fixture.flush();

    assert.deepEqual(fixture.uploaded, [{ name: "book.md", markdown: "# Book\n\nConverted content." }]);
    assert.equal(status().dataset.state, "success");
    assert.match(status().textContent ?? "", /Added book\.md/);
    assert.match(status().textContent ?? "", /Page 2 was image-only/);
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 1);
  } finally {
    fixture.restore();
  }
});

test("onResync re-reads paths and the Architect conversation after missed notifications", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("First plan.")] })],
  });
  try {
    await mounted(fixture);
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Build durable/);

    const changed: LearningPath = {
      ...path,
      goal: "Updated goal after reconnect.",
      updatedAt: "2026-02-02T00:00:00.000Z",
    };
    fixture.paths.set(path.id, changed);
    const conversation = structuredClone(fixture.conversations.get("chat-architect")!);
    conversation.messages = [...conversation.messages, assistant("Recovered plan after reconnect.")];
    fixture.conversations.set("chat-architect", conversation);
    await fixture.flush();
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "",
      /Build durable/,
      "a missed notification leaves the view stale",
    );

    const before = fixture.calls.length;
    fixture.resync();
    await fixture.flush();
    const names = fixture.calls.slice(before).map((call) => call.name);
    assert.ok(names.includes("paths.list"));
    assert.ok(names.includes("paths.get"));
    assert.ok(names.includes("architect.get"));
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "",
      /Updated goal after reconnect\./,
    );
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Recovered plan after reconnect."),
      "the Architect transcript recovers from the authoritative snapshot",
    );

    const callsAfterResync = fixture.calls.length;
    fixture.controller.abort();
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsAfterResync, "resync listeners are released with the view");
  } finally {
    fixture.restore();
  }
});

test("the detailed view floats: it never squeezes the roadmap, and Close deselects", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);

    // The inspector is a floating sibling of the body, not a grid column, so
    // the roadmap and the Architect conversation keep their full width.
    const body = fixture.root.querySelector<HTMLElement>(".lp-hub-body")!;
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    assert.notEqual(pane.parentElement, body, "the detailed view is not a body column");
    assert.equal(pane.hidden, false, "the first selected node opens the floating details");

    const close = liveButtons(fixture).find((button) => button.props.label === "Close")!;
    assert.ok(close, "the floating pane carries a close control");
    await close.props.onClick();
    await fixture.flush();

    assert.equal(pane.hidden, true, "closing deselects and hides the floating window");
    assert.ok(!fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId);
    assert.equal(roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"), "false");

    // The live app refreshes in the background (notifications, resync). A
    // closed detailed view must stay closed instead of silently reselecting.
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    fixture.resync();
    await fixture.flush();
    assert.equal(pane.hidden, true, "a background refresh never reopens the closed window");
    assert.ok(!fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId);
    assert.equal(
      body.querySelectorAll(":scope > *").length,
      2,
      "the body keeps exactly the roadmap pane and the Architect pane",
    );

    // Reopening via a card click brings the same inspector back.
    await selectRoadmapCard(fixture.root, "n-concept");
    assert.equal(pane.hidden, false);
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId, "n-concept");
  } finally {
    fixture.restore();
  }
});

test("an empty hub offers Create a Path and does not invent a roadmap or inspector node", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect-pane")!.hidden, false);
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.textContent ?? "", /Select a node/);
    assert.equal(
      fixture.root.querySelectorAll(".lp-roadmap-card").length,
      0,
      "no empty roadmap is drawn without a path",
    );
    const create = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await create.props.onClick();
    await fixture.flush();
    assert.equal(fixture.conversations.size, 0, "opening a draft does not lock in the model yet");
    assert.equal(fixture.paths.size, 0, "the Architect creates paths through save_learning_path, not the header");
    assert.ok(fixture.all("mountMarkdown").length === 0);
  } finally {
    fixture.restore();
  }
});

test("Path Hub exports the selected path as JSON and Markdown from its menu", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const exported: { format: string; filename: string; content: string }[] = [];
    mountPathHub(fixture.context, fixture.root, fixture.context.signal, {
      onExport(item) {
        exported.push(item);
      },
    });
    await fixture.flush();

    const exportButton = () =>
      fixture.findLast("mountButton", (record) => record.props.label === "Export Path");
    assert.equal(exportButton().props.disabled, false);
    await exportButton().props.onClick();
    const jsonMenu = fixture.findLast("openMenu");
    assert.equal(jsonMenu.props.label, "Export learning path");
    assert.equal(jsonMenu.props.preferredSide, "down");
    assert.deepEqual(
      jsonMenu.props.items.map((item: { key: string }) => item.key),
      ["export-json", "export-markdown"],
    );
    await jsonMenu.props.items.find((item: { key: string }) => item.key === "export-json").onSelect();
    await fixture.flush();

    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.export").at(-1)?.input, {
      pathId: path.id,
      format: "json",
    });
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.format, "json");
    assert.equal(exported[0]!.filename, "linear-algebra-from-canon.json");
    assert.equal(JSON.parse(exported[0]!.content).id, path.id);

    await exportButton().props.onClick();
    const markdownMenu = fixture.findLast("openMenu");
    await markdownMenu.props.items
      .find((item: { key: string }) => item.key === "export-markdown")
      .onSelect();
    await fixture.flush();

    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.export").at(-1)?.input, {
      pathId: path.id,
      format: "markdown",
    });
    assert.equal(exported.length, 2);
    assert.equal(exported[1]!.format, "markdown");
    assert.equal(exported[1]!.filename, "linear-algebra-from-canon.md");
    assert.match(exported[1]!.content, /^# Linear algebra from canon/);
  } finally {
    fixture.restore();
  }
});

test("Path Hub disables Export Path when there is no selected path", async () => {
  const fixture = createViewFixture();
  try {
    mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    const exportButton = fixture.find("mountButton", (record) => record.props.label === "Export Path");
    assert.equal(exportButton.props.disabled, true);
    await exportButton.props.onClick();
    assert.equal(fixture.all("openMenu").length, 0);
  } finally {
    fixture.restore();
  }
});
