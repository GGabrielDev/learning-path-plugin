/** Workspace backend operations.
 *
 * Verifies the JSON bridge the Node Inspector uses: verbatim note storage, the
 * bounded read, learner-filing metadata updates, deletion, and the fact that no
 * agent tool can write learner items. Uses the same in-process host as the
 * session RPC tests; no model request is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACES_DIRECTORY,
  WORKSPACE_FILES_DIRECTORY,
  openLearningPathStore,
} from "../src/store.ts";
import { MAX_WORKSPACE_NOTE_BYTES } from "../src/domain.ts";
import { makeItem, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import { EVENT_WORKSPACE_CHANGED } from "../src/topics.ts";

function hostWithPath(): { host: TestHost; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-ws-rpc-"));
  openLearningPathStore(directory).savePath(makePath());
  return { host: createHost({ dataDirectory: directory }), directory };
}

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test("workspace.saveNote stores the learner's Markdown verbatim and links it to a node", async () => {
  const { host, directory } = hostWithPath();
  try {
    // Leading whitespace, an H1 and a code fence: nothing may be reflowed.
    const markdown = "\n# Unformatted exactly as written\n\n- a  list with two  spaces\n\n```js\n  indent();\n```\n\n";
    const saved = await host.call<{
      item: { id: string; kind: string; title: string; addedBy: string; links: { to: string; rel: string }[]; byteSize: number };
    }>("workspace.saveNote", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      title: "Feynman notes on vector spaces",
      markdown,
    });
    assert.equal(saved.item.kind, "note");
    assert.equal(saved.item.title, "Feynman notes on vector spaces");
    assert.equal(saved.item.addedBy, "learner");
    assert.deepEqual(saved.item.links, [{ to: "n-skill", rel: "informs" }]);
    assert.equal(saved.item.byteSize, Buffer.byteLength(markdown, "utf8"));
    assert.ok(host.events.some((event) => event.topic === EVENT_WORKSPACE_CHANGED));

    // Files are the truth: the content file carries the exact bytes.
    const contentFile = path.join(
      directory,
      WORKSPACES_DIRECTORY,
      "path-linear-algebra",
      WORKSPACE_FILES_DIRECTORY,
      `${saved.item.id}.md`,
    );
    assert.equal(fs.readFileSync(contentFile, "utf8"), markdown);

    const read = await host.call<{ item: { id: string }; content: string | null }>("workspace.readItem", {
      pathId: "path-linear-algebra",
      itemId: saved.item.id,
    });
    assert.equal(read.content, markdown, "workspace.readItem returns the note verbatim");

    const reopened = openLearningPathStore(directory);
    assert.equal(reopened.workspace("path-linear-algebra")?.items.length, 1);
  } finally {
    close(host, directory);
  }
});

test("workspace.saveNote validates path, title and content bound before writing", async () => {
  const { host, directory } = hostWithPath();
  try {
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "missing", title: "t", markdown: "x" }),
      /Unknown path: missing/,
    );
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "path-linear-algebra", title: "   ", markdown: "x" }),
      /title must not be blank/,
    );
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "path-linear-algebra", title: "t", markdown: "   " }),
      /markdown must not be blank/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          title: "t",
          markdown: "x".repeat(MAX_WORKSPACE_NOTE_BYTES + 1),
        }),
      /markdown must be at most/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          nodeId: "n-missing",
          title: "t",
          markdown: "x",
        }),
      /unknown node id "n-missing"/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          nodeId: "n-skill",
          rel: "grounds_but_worse",
          title: "t",
          markdown: "x",
        }),
      /rel must be one of/,
    );
    assert.equal(
      openLearningPathStore(directory).workspace("path-linear-algebra"),
      null,
      "a rejected save materializes nothing",
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.list is null before the first item and returns the manifest after", async () => {
  const { host, directory } = hostWithPath();
  try {
    const before = await host.call<{ workspace: unknown }>("workspace.list", {
      pathId: "path-linear-algebra",
    });
    assert.equal(before.workspace, null);
    await assert.rejects(() => host.call("workspace.list", { pathId: "missing" }), /Unknown path/);

    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const after = await host.call<{ workspace: { items: { title: string }[] | null } }>(
      "workspace.list",
      { pathId: "path-linear-algebra" },
    );
    assert.deepEqual(
      (after.workspace?.items ?? []).map((item) => item.title),
      ["Feynman notes on vector spaces"],
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.readItem is bounded and refuses unknown or file-less items", async () => {
  const { host, directory } = hostWithPath();
  try {
    const store = openLearningPathStore(directory);
    store.saveSource({ name: "paper.md", markdown: "source body" });
    const sources = store.sources();
    store.saveWorkspaceItem(
      "path-linear-algebra",
      { kind: "source", title: "A paper", addedBy: "learner", sourceId: sources[0]!.sourceId },
    );
    store.saveWorkspaceItem("path-linear-algebra", makeItem(), "note body");

    await assert.rejects(
      () =>
        host.call("workspace.readItem", {
          pathId: "path-linear-algebra",
          itemId: "11111111-1111-1111-1111-111111111111",
        }),
      /Unknown workspace item/,
    );
    const source = await host.call<{ item: { kind: string }; content: string | null }>(
      "workspace.readItem",
      { pathId: "path-linear-algebra", itemId: store.workspace("path-linear-algebra")!.items[0]!.id },
    );
    assert.equal(source.item.kind, "source");
    assert.equal(source.content, null, "source items reference the global store and carry no file");
  } finally {
    close(host, directory);
  }
});

test("workspace.updateItemMeta is learner filing only: title, caption and links", async () => {
  const { host, directory } = hostWithPath();
  try {
    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const store = openLearningPathStore(directory);
    const itemId = store.workspace("path-linear-algebra")!.items[0]!.id;

    const relabeled = await host.call<{ item: { title: string; caption?: string } }>(
      "workspace.updateItemMeta",
      { pathId: "path-linear-algebra", itemId, title: "Renamed notes", caption: "From Tuesday" },
    );
    assert.equal(relabeled.item.title, "Renamed notes");
    assert.equal(relabeled.item.caption, "From Tuesday");

    const cleared = await host.call<{ item: { caption?: string } }>("workspace.updateItemMeta", {
      pathId: "path-linear-algebra",
      itemId,
      caption: null,
    });
    assert.equal(cleared.item.caption, undefined, "an explicit null caption clears it");

    const unlinked = await host.call<{ item: { links: unknown[] } }>("workspace.updateItemMeta", {
      pathId: "path-linear-algebra",
      itemId,
      links: [],
    });
    assert.deepEqual(unlinked.item.links, []);

    await assert.rejects(
      () =>
        host.call("workspace.updateItemMeta", {
          pathId: "path-linear-algebra",
          itemId,
          links: [{ to: "n-missing", rel: "informs" }],
        }),
      /unknown node id "n-missing"/,
    );
    await assert.rejects(
      () => host.call("workspace.updateItemMeta", { pathId: "path-linear-algebra", itemId }),
      /needs title, caption or links/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.updateItemMeta", {
          pathId: "path-linear-algebra",
          itemId,
          progression: "consolidated",
        }),
      /needs title, caption or links/,
      "non-filing keys change nothing and are refused",
    );

    const stored = openLearningPathStore(directory).workspace("path-linear-algebra")!.items[0]!;
    assert.equal(stored.title, "Renamed notes");
    assert.deepEqual(stored.links, []);
  } finally {
    close(host, directory);
  }
});

test("workspace.deleteItem removes the item and its content file exactly once", async () => {
  const { host, directory } = hostWithPath();
  try {
    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const itemId = openLearningPathStore(directory).workspace("path-linear-algebra")!.items[0]!.id;

    const first = await host.call<{ deleted: boolean }>("workspace.deleteItem", {
      pathId: "path-linear-algebra",
      itemId,
    });
    assert.equal(first.deleted, true);
    assert.ok(
      host.events.some(
        (event) => event.topic === EVENT_WORKSPACE_CHANGED && (event.data as { deleted?: boolean }).deleted === true,
      ),
    );

    const second = await host.call<{ deleted: boolean }>("workspace.deleteItem", {
      pathId: "path-linear-algebra",
      itemId,
    });
    assert.equal(second.deleted, false, "deleting twice is a no-op");

    assert.equal(openLearningPathStore(directory).workspace("path-linear-algebra")?.items.length, 0);
    const filesDirectory = path.join(
      directory,
      WORKSPACES_DIRECTORY,
      "path-linear-algebra",
      WORKSPACE_FILES_DIRECTORY,
    );
    assert.deepEqual(fs.readdirSync(filesDirectory), [], "the content file goes with the item");
  } finally {
    close(host, directory);
  }
});

test("no agent tool writes learner workspace items; agents only read", async () => {
  const { host, directory } = hostWithPath();
  try {
    // The Architect definition is registered lazily on the first create.
    await host.call("architect.create", {});
    const architectTools = [...host.definitions.get("path-architect")!.tools ?? []].map(
      (tool) => tool.name,
    );
    assert.deepEqual(
      architectTools.filter((name) => name.startsWith("workspace_")),
      [],
      "the Architect definition carries no workspace write tool",
    );
    const nativeToolNames = host
      .toolContributions.flatMap((contribution) => contribution.agents)
      .length > 0
      ? (await import("../src/tool-names.ts")).LEARNING_PATH_TOOL_NAMES
      : [];
    assert.ok(
      nativeToolNames.every((name) => !name.includes("save") && !name.includes("delete")),
      "native tools stay read-only for learner items",
    );
  } finally {
    close(host, directory);
  }
});
