/** Path Hub workspace pane UI tests.
 *
 * The ledger left the Node Inspector's inline section (live-review override):
 * the inspector carries one calm affordance that opens a floating, closable,
 * scrollable pane. The pane lists metadata only, newest last; an item's
 * content is fetched lazily through workspace.readItem when the learner opens
 * it in the read-only viewer; links are filed multi-node from the pane's node
 * picker. The guardrail sweep stays: no unread counts or "new" badges anywhere
 * in the mounted hub. The in-memory backend in view-host backs the workspace
 * RPCs; nothing touches storage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import { buildChildSessionBrief } from "../src/framework.ts";
import { clearPathHubTarget } from "../src/session-navigation.ts";
import type { NativeSessionHost } from "../src/native-session-host.ts";
import type { WorkspaceManifest } from "../src/domain.ts";
import { ITEM_ID, makeItem, makePath } from "./fixtures.ts";
import { createViewFixture, fire, selectRoadmapCard } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function fakeHost(): NativeSessionHost {
  return {
    async create() {
      throw new Error("not used");
    },
    stageOpeningPrompt() {
      return true;
    },
    clearOpeningPrompt() {},
  } as unknown as NativeSessionHost;
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  mountPathHub(fixture.context, fixture.root, fixture.context.signal, { sessionHost: fakeHost() });
  await fixture.flush();
  await fixture.flush();
  return fixture.root;
}

function button(fixture: ViewFixture, label: string) {
  const found = fixture.all("mountButton").filter((record) => record.props.label === label);
  assert.ok(found.length > 0, `Missing button ${label}`);
  return found;
}

interface WorkspaceLink {
  readonly to: string;
  readonly rel: string;
}

interface WorkspaceCall {
  readonly name: string;
  readonly input: {
    pathId?: string;
    itemId?: string;
    links?: WorkspaceLink[];
    nodeId?: string;
    title?: string;
    markdown?: string;
  };
}

function calls(fixture: ViewFixture, name: string): WorkspaceCall[] {
  return fixture.calls.filter((call): call is WorkspaceCall => call.name === name);
}

function lastCall(fixture: ViewFixture, name: string): WorkspaceCall | undefined {
  return calls(fixture, name).at(-1);
}

function inspector(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-inspector");
  assert.ok(element);
  return element;
}

function workspacePane(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-workspace-pane");
  assert.ok(element, "the workspace pane is rendered");
  return element;
}

function paneRoot(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-workspace-pane");
  assert.ok(element, "the workspace pane is rendered");
  return element;
}

function workspaceBody(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-workspace-body");
  assert.ok(element, "the pane body is rendered");
  return element;
}

/** The row's title is itself a mounted button (it opens the viewer), so its
 * text lives in widget props, not in the row's DOM text. */
function rowTitleButton(fixture: ViewFixture, row: HTMLElement, label: string) {
  const found = fixture
    .all("mountButton")
    .find((record) => record.props.label === label && row.contains(record.container));
  assert.ok(found, `the row for "${label}" carries its title button`);
  return found!;
}

async function openPane(fixture: ViewFixture): Promise<HTMLElement> {
  const affordance = fixture.all("mountButton").filter((record) =>
    String(record.props.label ?? "").startsWith("Workspace ledger"),
  );
  assert.ok(affordance.length > 0, "the inspector carries one workspace affordance");
  await affordance[0]!.props.onClick();
  await fixture.flush();
  const pane = workspacePane(fixture.root);
  assert.equal(pane.hidden, false, "the affordance opens the pane");
  return pane;
}

const initialItem = (overrides = {}) =>
  makeItem({ links: [{ to: "n-skill", rel: "informs" }], ...overrides });

test("the inspector shows one calm affordance; the pane opens and closes", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();

    // One affordance, honestly counted, and no inline ledger rows in the
    // inspector at all.
    assert.ok(button(fixture, "Workspace ledger (1 item)").length === 1);
    const section = [...inspector(fixture.root).querySelectorAll<HTMLElement>(".lp-inspector-section")].find(
      (candidate) => candidate.querySelector(".lp-workspace-open"),
    );
    assert.ok(section, "the affordance lives in the Workspace section");
    assert.match(section!.textContent ?? "", /opens the ledger pane/);
    assert.equal(fixture.root.querySelector(".lp-workspace-row"), null, "no inline ledger rows");

    // The pane floats closed until the affordance opens it.
    const pane = workspacePane(fixture.root);
    assert.equal(pane.hidden, true, "the pane starts closed");

    await openPane(fixture);
    const rows = [...pane.querySelectorAll<HTMLElement>(".lp-workspace-row")];
    assert.equal(rows.length, 1, "the pane carries the ledger");
    assert.match(workspaceBody(fixture.root).textContent ?? "", /1 item/);

    // Closing is the pane's own control (scoped to the pane: the inspector
    // has its own Close); refreshes keep a closed pane closed.
    const paneClose = fixture
      .all("mountButton")
      .filter((record) => record.props.label === "Close" && pane.contains(record.container));
    assert.equal(paneClose.length, 1);
    await paneClose[0]!.props.onClick();
    await fixture.flush();
    assert.equal(pane.hidden, true, "the pane's Close closes it");

    await openPane(fixture);
    assert.equal(pane.hidden, false, "the affordance reopens the pane");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the pane lists items newest last with honest counts and no unread or new state", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      { item: initialItem(), content: "older note" },
      {
        item: makeItem({
          id: "3f2504e0-4f89-11d3-9a0c-0305e82c3302",
          title: "Later margin note",
          addedAt: "2026-02-01T00:00:00.000Z",
          links: [],
        }),
        content: "newer note",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    const rows = [...workspaceBody(fixture.root).querySelectorAll<HTMLElement>(".lp-workspace-row")];
    assert.deepEqual(
      rows.map((row) => row.dataset.itemId),
      [ITEM_ID, "3f2504e0-4f89-11d3-9a0c-0305e82c3302"],
      "oldest first, newest last",
    );
    rowTitleButton(fixture, rows[0]!, "Feynman notes on vector spaces");
    assert.match(rows[0]!.textContent ?? "", /Note/);
    assert.match(rows[0]!.textContent ?? "", /linked: Node n-skill \(informs\)/);
    assert.match(rows[1]!.textContent ?? "", /unlinked/);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /2 items/);

    // The guardrail sweep runs over the pane's text, as the inline section's
    // test did over its section, and over every mounted badge anywhere.
    const text = workspaceBody(fixture.root).textContent ?? "";
    assert.doesNotMatch(text, /unread/i);
    assert.doesNotMatch(text, /\bnew\b/i, "no 'new' badges anywhere in the ledger");
    const badges = fixture
      .all("mountBadge")
      .filter((record) => /unread|new/i.test(String(record.props.text ?? "")));
    assert.deepEqual(badges, [], "no unread or new badge is mounted for workspace state");
    assert.ok(fire, "fire helper stays imported for parity with sibling tests");

    // Listing is metadata only: no content read has happened yet.
    assert.equal(calls(fixture, "workspace.readItem").length, 0);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("item content loads on demand: readItem fires only when the viewer opens", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "# Verbatim body\n\n- kept  as  typed\n" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    // Mounting the hub and listing the ledger fetched no content at all.
    assert.equal(calls(fixture, "workspace.readItem").length, 0, "no eager content reads");
    assert.equal(fixture.all("mountMarkdown").length, 0, "no markdown mounted before opening");

    const row = workspaceBody(fixture.root).querySelector<HTMLElement>(".lp-workspace-row")!;
    const titleButton = rowTitleButton(fixture, row, "Feynman notes on vector spaces");

    await titleButton.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const read = lastCall(fixture, "workspace.readItem");
    assert.ok(read, "the content is read on demand");
    assert.equal(read!.input.itemId, ITEM_ID);

    const body = workspaceBody(fixture.root);
    assert.ok(button(fixture, "Back to list").length === 1, "the viewer offers the way back");
    assert.match(body.textContent ?? "", /Feynman notes on vector spaces/);
    const markdown = fixture.all("mountMarkdown").at(-1);
    assert.ok(markdown, "the viewer renders the content read-only");
    assert.equal(markdown!.props.text, "# Verbatim body\n\n- kept  as  typed\n");

    // Back to the list: no second read, and the row is there again.
    await button(fixture, "Back to list")[0]!.props.onClick();
    await fixture.flush();
    assert.equal(calls(fixture, "workspace.readItem").length, 1, "returning does not re-read");
    assert.ok(workspaceBody(fixture.root).querySelector(".lp-workspace-row"));
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the viewer is read-only: no composer, no editable surface for item content", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);
    const row = workspaceBody(fixture.root).querySelector<HTMLElement>(".lp-workspace-row")!;
    const titleButton = rowTitleButton(fixture, row, "Feynman notes on vector spaces");
    await titleButton.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const composerInPane = fixture
      .all("mountStandardComposer")
      .some((record) => paneRoot(fixture.root).contains(record.container));
    assert.equal(composerInPane, false, "no composer is mounted inside the pane");
    assert.equal(
      workspaceBody(fixture.root).querySelector("textarea, input:not([type='checkbox'])"),
      null,
      "the viewer carries no editable field",
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a source item references the sources store and carries no content read", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          kind: "source",
          title: "A referenced paper",
          sourceId: "source-1",
          links: [{ to: "n-skill", rel: "grounds" }],
        }),
        content: "",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);
    const row = workspaceBody(fixture.root).querySelector<HTMLElement>(".lp-workspace-row")!;
    assert.match(row.textContent ?? "", /Source/);
    const titleButton = rowTitleButton(fixture, row, "A referenced paper");
    await titleButton.props.onClick();
    await fixture.flush();
    await fixture.flush();
    assert.equal(calls(fixture, "workspace.readItem").length, 1);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /source library/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("session artifacts render in the pane with their originating session", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          kind: "session_artifact",
          title: "Saved relational map",
          addedBy: "session:chat-map-1",
          links: [{ to: "n-skill", rel: "produced_by" }],
        }),
        content: "# Map of the earlier session",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    const row = workspaceBody(fixture.root).querySelector<HTMLElement>(".lp-workspace-row")!;
    assert.ok(row, "the saved artifact appears in the ledger");
    assert.match(row.textContent ?? "", /Session artifact/);
    rowTitleButton(fixture, row, "Saved relational map");
    assert.match(row.textContent ?? "", /saved by session chat-map-1/);

    const titleButton = rowTitleButton(fixture, row, "Saved relational map");
    await titleButton.props.onClick();
    await fixture.flush();
    await fixture.flush();
    const markdown = fixture.all("mountMarkdown").at(-1);
    assert.ok(markdown, "the saved artifact renders inside the pane");
    assert.equal(markdown!.props.text, "# Map of the earlier session");
    assert.match(workspaceBody(fixture.root).textContent ?? "", /saved by session chat-map-1/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Add Note files an unlinked note or links it to several nodes at once", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openPane(fixture);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /No workspace items yet/);

    await button(fixture, "Add Note")[0]!.props.onClick();
    await fixture.flush();
    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Add Workspace Note");
    const content = dialog.contentContainer!;

    const titleInput = content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!;
    const bodyInput = content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!;
    titleInput.value = "Feynman notes on vector spaces";
    bodyInput.value = "# Written in my own editor\n\n- kept  as  typed\n";

    // The node picker defaults to the inspected node only.
    const checkboxes = [...content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")];
    assert.equal(checkboxes.length, 6, "every node of the path is pickable");
    const checkedNow = checkboxes.filter((input) => input.checked).map((input) => input.value);
    assert.deepEqual(checkedNow, ["n-concept"]);

    // Link to three nodes at once.
    for (const value of ["n-skill", "n-holistic"]) {
      const input = checkboxes.find((candidate) => candidate.value === value)!;
      input.checked = true;
    }

    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.saveNote");
    assert.ok(saved);
    assert.equal(saved.input.markdown, bodyInput.value, "the markdown is passed verbatim");
    assert.deepEqual(
      [...(saved.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "n-concept", rel: "informs" },
        { to: "n-holistic", rel: "informs" },
        { to: "n-skill", rel: "informs" },
      ],
      "one save files the note under several nodes",
    );

    const row = fixture.root.querySelector<HTMLElement>(".lp-workspace-row");
    assert.ok(row, "the saved note appears in the pane");
    rowTitleButton(fixture, row, "Feynman notes on vector spaces");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a note created with no node checked is unlinked", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openPane(fixture);
    await button(fixture, "Add Note")[0]!.props.onClick();
    await fixture.flush();
    const content = fixture.find("openDialog").contentContainer!;
    content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!.value = "Loose scratchpad";
    content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!.value = "body";
    const inspected = [...content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")].find(
      (input) => input.value === "n-concept",
    )!;
    inspected.checked = false;

    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.saveNote");
    assert.ok(saved);
    assert.deepEqual(saved.input.links, [], "no checked node means an unlinked note");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the Links dialog files one item under several nodes and preserves relations", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      { item: makeItem({ links: [{ to: "n-skill", rel: "produced_by" }] }), content: "body" },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openPane(fixture);

    await button(fixture, "Links…")[0]!.props.onClick();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog");
    assert.match(dialog.props.title, /Links — Feynman notes/);
    const checkboxes = [...dialog.contentContainer!.querySelectorAll<HTMLInputElement>(
      ".lp-workspace-picker input[type='checkbox']",
    )];
    assert.deepEqual(
      checkboxes.filter((input) => input.checked).map((input) => input.value),
      ["n-skill"],
      "the item's existing links start checked",
    );

    // File the item under two more nodes as well.
    for (const value of ["n-concept", "n-holistic"]) {
      checkboxes.find((candidate) => candidate.value === value)!.checked = true;
    }
    await button(fixture, "Save Links")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.updateItemMeta");
    assert.ok(saved);
    assert.equal(saved.input.itemId, ITEM_ID);
    assert.deepEqual(
      [...(saved.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "n-concept", rel: "informs" },
        { to: "n-holistic", rel: "informs" },
        { to: "n-skill", rel: "produced_by" },
      ],
      "new links file rel informs; existing relations are preserved",
    );

    const row = fixture.root.querySelector<HTMLElement>(".lp-workspace-row")!;
    assert.match(row.textContent ?? "", /Node n-skill \(produced_by\)/);
    assert.match(row.textContent ?? "", /Node n-concept \(informs\)/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("unlinking through the picker removes only the unchecked node's link", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          links: [
            { to: "n-skill", rel: "informs" },
            { to: "n-concept", rel: "informs" },
          ],
        }),
        content: "body",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    await button(fixture, "Links…")[0]!.props.onClick();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog");
    const checkboxes = [...dialog.contentContainer!.querySelectorAll<HTMLInputElement>(
      ".lp-workspace-picker input[type='checkbox']",
    )];
    checkboxes.find((candidate) => candidate.value === "n-concept")!.checked = false;

    await button(fixture, "Save Links")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.updateItemMeta");
    assert.deepEqual(
      [...(saved!.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [{ to: "n-skill", rel: "informs" }],
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a note linked to three nodes appears in each node's session brief", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    await button(fixture, "Add Note")[0]!.props.onClick();
    await fixture.flush();
    const content = fixture.find("openDialog").contentContainer!;
    content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!.value = "Feynman notes on vector spaces";
    content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!.value = "body";
    for (const input of content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")) {
      input.checked = ["n-skill", "n-concept", "n-holistic"].includes(input.value);
    }
    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    // Read the manifest the way the hub did after the save.
    const manifest = await fixture.context.call<{ workspace: WorkspaceManifest | null }>(
      "workspace.list",
      { pathId: path.id },
    );
    assert.equal(manifest.workspace?.items.length, 1);
    for (const nodeId of ["n-skill", "n-concept", "n-holistic"]) {
      const brief = buildChildSessionBrief({
        path,
        nodeId,
        kind: "teaching",
        settings: fixture.settings,
        workspace: manifest.workspace,
      });
      assert.match(brief.text, /Feynman notes on vector spaces/, `the brief for ${nodeId} lists the note`);
    }
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Delete from the pane removes the item through the learner-filing RPC", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openPane(fixture);

    await button(fixture, "Delete")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();
    const deleted = lastCall(fixture, "workspace.deleteItem");
    assert.ok(deleted);
    assert.equal(deleted.input.itemId, ITEM_ID);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /No workspace items yet/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

/** A drop event carrying files, the way a real DragEvent arrives. */
function dropEvent(document: Document, files: File[], type: "dragover" | "drop"): Event {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  if (files.length > 0) {
    Object.defineProperty(event, "dataTransfer", { value: { files } });
  }
  return event;
}

function saveButton(fixture: ViewFixture): MountRecord {
  const found = fixture
    .all("mountButton")
    .find((record) => record.props.label === "Save to Workspace");
  assert.ok(found, "the filing dialog carries its save button");
  return found!;
}

test("dropping a PDF onto the pane converts it and files it as a node-linked source item", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openPane(fixture);
    const body = root.querySelector<HTMLElement>(".lp-workspace-body")!;

    // The pane must allow the drop: dragover is prevented so the browser
    // delivers it, and the pane shows the armed state while hovering.
    const over = dropEvent(body.ownerDocument, [], "dragover");
    body.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true, "the pane accepts a drop");
    assert.ok(body.classList.contains("lp-drop-target"), "the armed state is visible");

    const file = new File(["%PDF-1.4 pretend bytes"], "paper.pdf", { type: "application/pdf" });
    body.dispatchEvent(dropEvent(body.ownerDocument, [file], "drop"));
    await fixture.flush();
    assert.ok(!body.classList.contains("lp-drop-target"), "the armed state clears on drop");

    const dialog = fixture.all("openDialog").at(-1)!;
    assert.match(String(dialog.props.title), /paper\.pdf/, "the filing dialog opens for the dropped file");
    await fixture.flush();
    assert.equal(saveButton(fixture).props.disabled, false, "conversion enables the save");
    assert.equal(fixture.uploaded.length, 0, "no library write before the learner confirms");

    await saveButton(fixture).props.onClick();
    await fixture.flush();
    await fixture.flush();

    const call = calls(fixture, "workspace.saveSource").at(-1);
    assert.deepEqual(call?.input, {
      pathId: "path-linear-algebra",
      name: "paper.pdf",
      markdown: "# paper.pdf\n\nConverted text.",
      links: [{ to: "n-skill", rel: "grounds" }],
    }, "the picker's default (the node in view) supplies the grounds link");
    assert.equal(fixture.uploaded.length, 1, "the document lives once, in the global library");

    // The ledger re-renders with the filed source item.
    const row = fixture
      .all("mountButton")
      .find((record) => record.props.label === "paper.pdf");
    assert.ok(row, "the ledger lists the filed document");
    assert.ok(dialog.handle, "the dialog closed after saving");
  } finally {
    fixture.restore();
  }
});

test("a dropped file the converter cannot take surfaces the error and saves nothing", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openPane(fixture);
    const body = root.querySelector<HTMLElement>(".lp-workspace-body")!;
    fixture.toMarkdown = async () => {
      throw new Error("Only UTF-8 text or a valid PDF can be converted.");
    };

    const file = new File(["%PDF-1.4 broken"], "broken.pdf", { type: "application/pdf" });
    body.dispatchEvent(dropEvent(body.ownerDocument, [file], "drop"));
    await fixture.flush();

    const error = root.querySelector<HTMLElement>(".lp-dialog-error");
    assert.ok(error);
    assert.match(error.textContent ?? "", /Could not convert broken\.pdf/);
    assert.match(error.textContent ?? "", /Only UTF-8 text or a valid PDF/);
    assert.equal(saveButton(fixture).props.disabled, true, "a failed conversion never enables the save");
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);

    // Closing the dialog is the cancel path: nothing was written.
    fixture.all("openDialog").at(-1)!.handle.dispose();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);
    assert.equal(fixture.uploaded.length, 0);
  } finally {
    fixture.restore();
  }
});

test("a dropped file type outside the converter is ignored, and cancelling writes nothing", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openPane(fixture);
    const body = root.querySelector<HTMLElement>(".lp-workspace-body")!;

    const image = new File(["png"], "picture.png", { type: "image/png" });
    body.dispatchEvent(dropEvent(body.ownerDocument, [image], "drop"));
    await fixture.flush();
    assert.equal(fixture.all("openDialog").length, 0, "an unconvertible file opens no dialog");

    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    body.dispatchEvent(dropEvent(body.ownerDocument, [file], "drop"));
    await fixture.flush();
    assert.equal(fixture.all("openDialog").length, 1, "a markdown drop opens the filing dialog");
    fixture.all("openDialog").at(-1)!.handle.dispose();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);
    assert.equal(fixture.uploaded.length, 0, "cancelling files nothing");
  } finally {
    fixture.restore();
  }
});
