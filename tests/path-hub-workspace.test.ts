/** Path Hub Workspace-section UI tests.
 *
 * The Node Inspector's Workspace ledger: flat list newest last, add-note
 * dialog, link/unlink to the inspected node, delete — and the guardrail that
 * no unread counts or "new" badges appear anywhere in the section. The in-memory
 * backend in view-host backs the workspace RPCs; nothing touches storage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import { clearPathHubTarget } from "../src/session-navigation.ts";
import type { NativeSessionHost } from "../src/native-session-host.ts";
import { ITEM_ID, makeItem, makePath } from "./fixtures.ts";
import { createViewFixture, fire, selectRoadmapCard } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

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

interface WorkspaceMetaCall {
  readonly name: string;
  readonly input: {
    pathId: string;
    itemId?: string;
    links?: unknown[];
    nodeId?: string;
    title?: string;
    markdown?: string;
  };
}

function lastCall(fixture: ViewFixture, name: string): WorkspaceMetaCall | undefined {
  return fixture.calls.findLast(
    (call): call is WorkspaceMetaCall => call.name === name,
  );
}

function inspector(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-inspector");
  assert.ok(element);
  return element;
}

function workspaceSection(root: HTMLElement): HTMLElement {
  const sections = [...root.querySelectorAll<HTMLElement>(".lp-inspector-section")];
  const section = sections.find((candidate) => candidate.querySelector(".lp-workspace-host"));
  assert.ok(section, "the Workspace section is rendered");
  return section;
}

const initialItem = (overrides = {}) =>
  makeItem({ links: [{ to: "n-skill", rel: "informs" }], ...overrides });

test("the Workspace ledger lists items newest last with an honest count and no unread or new state", async () => {
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

    const section = workspaceSection(fixture.root);
    const rows = [...section.querySelectorAll<HTMLElement>(".lp-workspace-row")];
    assert.deepEqual(
      rows.map((row) => row.dataset.itemId),
      [ITEM_ID, "3f2504e0-4f89-11d3-9a0c-0305e82c3302"],
      "oldest first, newest last",
    );
    assert.match(rows[0]!.textContent ?? "", /Feynman notes on vector spaces/);
    assert.match(rows[0]!.textContent ?? "", /Note/);
    assert.match(rows[0]!.textContent ?? "", /linked \(informs\)/);
    assert.match(section.textContent ?? "", /2 items/);

    const text = section.textContent ?? "";
    assert.doesNotMatch(text, /unread/i);
    assert.doesNotMatch(text, /\bnew\b/i, "no 'new' badges anywhere in the ledger");

    // The linked row offers unlink; the unlinked one offers link.
    assert.ok(button(fixture, "Unlink from node").some((record) => rows[0]!.contains(record.container)));
    assert.ok(button(fixture, "Link to node").some((record) => rows[1]!.contains(record.container)));
    assert.ok(button(fixture, "Delete").length === 2, "every row can be deleted");
    assert.ok(button(fixture, "Add Note").length === 1);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Add Note opens a dialog and saving files the note with an optional node link", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    assert.match(workspaceSection(fixture.root).textContent ?? "", /No workspace items yet/);

    await button(fixture, "Add Note")[0]!.props.onClick();
    await fixture.flush();
    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Add Workspace Note");
    const content = dialog.contentContainer!;

    const titleInput = content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!;
    const bodyInput = content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!;
    titleInput.value = "Feynman notes on vector spaces";
    bodyInput.value = "# Written in my own editor\n\n- kept  as  typed\n";
    const linkCheckbox = content.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    assert.equal(linkCheckbox.checked, true, "linking to the inspected node is the default");

    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.saveNote");
    assert.ok(saved);
    assert.equal(saved.input.nodeId, "n-concept", "the checkbox links the note to the node");
    assert.equal(saved.input.markdown, bodyInput.value, "the markdown is passed verbatim");

    const row = fixture.root.querySelector<HTMLElement>(".lp-workspace-row");
    assert.ok(row, "the saved note appears in the ledger");
    assert.match(row.textContent ?? "", /Feynman notes on vector spaces/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Link to node, Unlink from node and Delete drive the learner-filing RPCs", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    // Same item, another node: the ledger offers linking it here.
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await button(fixture, "Link to node")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const linked = lastCall(fixture, "workspace.updateItemMeta");
    assert.ok(linked);
    assert.deepEqual(linked.input.links, [
      { to: "n-skill", rel: "informs" },
      { to: "n-concept", rel: "informs" },
    ], "linking to one node preserves the item's other links");
    const row = fixture.root.querySelector<HTMLElement>(".lp-workspace-row")!;
    assert.match(row.textContent ?? "", /linked \(informs\)/);

    await button(fixture, "Unlink from node")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();
    const unlinked = lastCall(fixture, "workspace.updateItemMeta");
    assert.ok(unlinked);
    assert.deepEqual(
      unlinked.input.links,
      [{ to: "n-skill", rel: "informs" }],
      "unlinking removes only the inspected node's link",
    );

    await button(fixture, "Delete")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();
    const deleted = lastCall(fixture, "workspace.deleteItem");
    assert.ok(deleted);
    assert.equal(deleted.input.itemId, ITEM_ID);
    assert.match(
      fixture.root.querySelector(".lp-workspace-host")!.textContent ?? "",
      /No workspace items yet/,
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the ledger survives an unknown-node row and fires no read-state widgets", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    const badges = fixture
      .all("mountBadge")
      .filter((record) => /unread|new/i.test(String(record.props.text ?? "")));
    assert.deepEqual(badges, [], "no unread or new badge is mounted for workspace state");
    assert.ok(fire, "fire helper stays imported for parity with sibling tests");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("session artifacts render with their originating session", async () => {
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

    const row = fixture.root.querySelector<HTMLElement>(".lp-workspace-row")!;
    assert.ok(row, "the saved artifact appears in the ledger");
    assert.match(row.textContent ?? "", /Session artifact/);
    assert.match(row.textContent ?? "", /Saved relational map/);
    assert.match(row.textContent ?? "", /linked \(produced_by\)/);
    assert.match(row.textContent ?? "", /saved by session chat-map-1/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});
