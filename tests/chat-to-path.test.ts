import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginActionContext } from "learnharness-plugin-api";
import { CHAT_PATH_ARCHITECT_ID, CHAT_PATH_FOLLOW_UP } from "../src/chat-to-path.ts";
import { registerSessionActions } from "../src/session-actions.ts";
import { clearPathHubTarget, consumePathHubTarget, requestPathHubDraft } from "../src/session-navigation.ts";
import type { ChatPathPreview } from "../src/session-types.ts";
import { EVENT_ARCHITECT_CHANGED } from "../src/topics.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { createViewFixture, fire, makeConversation } from "./view-host.ts";

const chat = {
  id: "review-chat", title: "Teaching about page tables", kind: "teach" as const,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [],
};
const settings = { artifactDefaults: {}, chatToPathEnabled: true };
const proposal = makePath();

function attachContext(kind: "teaching" | "practice"): PluginActionContext {
  return { placement: "top-bar", surface: "session", sessionId: chat.id, kind, surfaceTarget: {} as never, view: {} as never };
}

test("Teaching-only Attach choice reads current settings; missing and pending outlines require a summary or cancellation", async () => {
  const fixture = createViewFixture();
  const backend = createHost({ chats: [chat] });
  try {
    const call = fixture.context.call.bind(fixture.context);
    fixture.context.call = (name, input) => name === "sessions.toPathPreview" || name === "settings.get"
      ? backend.call(name, input) : call(name, input);
    registerSessionActions(fixture.context);
    const attach = fixture.actions.find((entry) => entry.id === "lp-attach-session-to-path")!;
    const button = (label: string) => fixture.all("mountButton").findLast((entry) => !entry.disposed && entry.props.label === label);
    const openAttach = async (kind: "teaching" | "practice") => { await attach.run(attachContext(kind)); await fixture.flush(); };
    const openReview = async () => { await button("Create a Path from This Chat…")!.props.onClick(); await fixture.flush(); };
    const review = () => fixture.findLast("openDialog", (entry) => !entry.disposed).contentContainer!;

    await openAttach("teaching");
    assert.equal(button("Create a Path from This Chat…"), undefined);
    fixture.findLast("openDialog", (entry) => !entry.disposed).handle.dispose();
    await backend.call("settings.save", settings);
    await openAttach("practice");
    assert.equal(button("Create a Path from This Chat…"), undefined);
    fixture.findLast("openDialog", (entry) => !entry.disposed).handle.dispose();
    await openAttach("teaching");
    assert.match(review().textContent ?? "", /No learning paths/);
    await openReview();
    assert.match(review().textContent ?? "", /No saved plan outline is ready/);
    assert.equal(button("Review in Path Architect")!.props.disabled, true);
    await button("Cancel")!.props.onClick();
    assert.equal(consumePathHubTarget(), null);
    assert.deepEqual(fixture.openedViews, []);

    backend.addChat({ ...chat, tree: { version: 0, nodes: [], edges: [] } });
    await openAttach("teaching");
    await openReview();
    const summary = review().querySelector("textarea")!;
    summary.value = "I worked through address translation.";
    fire(summary, "input");
    const confirm = button("Review in Path Architect")!;
    assert.equal(confirm.props.disabled, false);
    backend.addChat({ ...chat, tree: { version: 1, nodes: [{ id: "one", title: "New background" }], edges: [] } });
    await confirm.props.onClick();
    assert.match(review().textContent ?? "", /has changed/);
    assert.equal(consumePathHubTarget(), null);
    await button("Cancel")!.props.onClick();

    await openAttach("teaching");
    await openReview();
    await button("Review in Path Architect")!.props.onClick();
    const unmounted = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    assert.match(fixture.find("mountStandardComposer").props.composer.value, /New background/);
    assert.deepEqual(fixture.openedViews, ["paths"]);
    assert.deepEqual(fixture.calls.filter((entry) => /architect\.(create|send)|sessions\.link|paths\.save/.test(entry.name)), []);
    assert.equal(backend.records.size, 0);
    unmounted();
  } finally {
    clearPathHubTarget();
    fixture.restore();
    backend.close();
  }
});

test("preview RPC is bounded and only returns the reviewed fields", async () => {
  const backend = createHost({ chats: [{ ...chat, title: "t".repeat(9_000), tree: {
    version: 1, nodes: Array.from({ length: 25 }, (_, index) => ({ id: String(index), title: "z".repeat(10_000), summary: "not imported" })), edges: [],
  } }] });
  try {
    await assert.rejects(backend.call("sessions.toPathPreview", { chatId: chat.id }), /disabled/);
    await backend.call("settings.save", settings);
    const result = await backend.call<ChatPathPreview>("sessions.toPathPreview", { chatId: chat.id });
    assert.deepEqual(Object.keys(result).sort(), ["busy", "outline", "revision", "title", "truncated"]);
    assert.equal(result.outline?.length, 2_000);
    assert.equal(result.title.length, 200);
    assert.equal(result.truncated, true);
    backend.removeChat(chat.id);
    await assert.rejects(backend.call("sessions.toPathPreview", { chatId: chat.id }), /no longer exists/);
  } finally {
    backend.close();
  }
});

test("warm hub preserves the reviewed seed instead of reusing the already-loaded Architect", async () => {
  const path = { ...proposal, architectChatId: "loaded" };
  const fixture = createViewFixture({ paths: [path], conversations: [makeConversation("loaded")] });
  try {
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    assert.ok(fixture.calls.some((entry) => entry.name === "architect.get"));
    requestPathHubDraft("Reviewed teaching background");
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "Reviewed teaching background");
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect")?.closest<HTMLElement>("[hidden]"), null);
    assert.ok(!fixture.calls.some((entry) => entry.name === "architect.create" || entry.name === "architect.send"));
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a busy Architect is not replaced or sent the reviewed background", async () => {
  const fixture = createViewFixture({
    paths: [{ ...proposal, architectChatId: "running" }],
    conversations: [makeConversation("running", { status: "running" })],
  });
  try {
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    requestPathHubDraft("Reviewed background");
    assert.match(fixture.root.textContent ?? "", /Architect is busy.*reopen the Teaching-chat review/);
    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, true);
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "");
    assert.ok(!fixture.calls.some((entry) => entry.name === "architect.create" || entry.name === "architect.send"));
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("chat-origin tools stage only; follow-up and an explicit approval of the displayed proposal precede the write", async () => {
  const backend = createHost({ chats: [chat] });
  const fixture = createViewFixture({ settings });
  try {
    await backend.call("settings.save", settings);
    const call = fixture.context.call.bind(fixture.context);
    fixture.context.call = (name, input) => name.startsWith("architect.") ? backend.call(name, input) : call(name, input);
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    requestPathHubDraft("Approved Teaching-chat background");
    const composer = () => fixture.find("mountStandardComposer").props.composer;
    const paths = async () => (await backend.call<{ paths: unknown[] }>("paths.list")).paths;
    assert.equal(backend.records.size, 0);
    composer().onSend();
    await fixture.flush();
    const record = [...backend.records.values()][0]!;
    assert.equal(record.definitionId, CHAT_PATH_ARCHITECT_ID);
    const pathTools = backend.definitions.get(record.definitionId)?.tools ?? [];
    assert.match(backend.definitions.get(record.definitionId)!.instructions, /first reply/);
    const stage = async (suffix: "" | "_json", toolCallId: string) => {
      const name = `save_learning_path${suffix}`;
      const tool = pathTools.find((candidate) => candidate.name === name)!;
      assert.ok(tool.execute);
      const result = await tool.execute(toolCallId, suffix ? { draftJson: JSON.stringify(proposal) } : proposal, backend.controller.signal);
      assert.ok(!result.isError);
      record.messages.push({ role: "toolResult", toolName: name, toolCallId, isError: false, ...result, timestamp: Date.now() });
      record.status = "idle";
      fixture.emit(EVENT_ARCHITECT_CHANGED, { id: record.id, messageCount: record.messages.length });
      await fixture.flush();
      assert.deepEqual(await paths(), []);
    };
    await stage("", "too-early");
    await assert.rejects(backend.call("architect.approveChatPath", { id: record.id, toolCallId: "too-early" }), /No current/);
    assert.match(fixture.root.textContent ?? "", new RegExp(CHAT_PATH_FOLLOW_UP.slice(0, 30), "i"));
    composer().onChange("I would like to study linear algebra next.");
    composer().onSend();
    await fixture.flush();
    await stage("_json", "displayed-proposal");
    assert.match(fixture.root.textContent ?? "", /Review proposed path: Linear algebra from canon/);
    await assert.rejects(backend.call("architect.approveChatPath", { id: record.id, toolCallId: "too-early" }), /No current/);
    const save = fixture.findLast("mountButton", (entry) => !entry.disposed && entry.props.label === "Approve and Save Path");
    await save.props.onClick();
    const result = await backend.call<{ path: typeof proposal }>("paths.get", { id: proposal.id });
    assert.equal(result.path.architectChatId, record.id);
    assert.equal((await paths()).length, 1);
    assert.ok(result.path.modules.flatMap((module) => module.nodes).every((node) => node.progression === "unstarted" && node.childSessions.length === 0));
    assert.deepEqual(backend.chats.get(chat.id), chat);
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
    backend.close();
  }
});
