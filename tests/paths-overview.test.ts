/** Paths overview tests.
 *
 * Mounted through the real Path Hub against the recorded host UI and the
 * in-memory backend: cards render honest inventory, the tag filter groups
 * client-side, tag edits save through `paths.updateMeta` and refetch, and the
 * whole surface disposes with the hub. No browser or model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation, setSelect } from "./view-host.ts";

function snapshot(id: string) {
  return makeConversation(id);
}

function makeTaggedPath(id: string, tags: readonly string[]): LearningPath {
  const path = makePath();
  return {
    ...path,
    id,
    title: `Path ${id}`,
    goal: `Goal for ${id}.`,
    ...(tags.length === 0 ? {} : { tags }),
  };
}

async function mounted(fixture: ReturnType<typeof createViewFixture>): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

function overviewCards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".lp-path-card")];
}

function cardButton(fixture: ReturnType<typeof createViewFixture>, pathId: string, label: string) {
  const card = fixture.root.querySelector<HTMLElement>(`.lp-path-card[data-path-id="${pathId}"]`);
  assert.ok(card, `Missing card for ${pathId}`);
  assert.ok(!card.hidden);
  const record = fixture
    .all("mountButton")
    .find((entry) => card.contains(entry.container) && entry.props.label === label);
  assert.ok(record, `Missing ${label} button on the card for ${pathId}`);
  return record;
}

test("the overview renders one honest-inventory card per path and none when empty", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", ["field:systems"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const pane = fixture.root.querySelector<HTMLElement>(".lp-overview-pane")!;
    assert.equal(pane.hidden, false);

    const cards = overviewCards(fixture.root);
    assert.equal(cards.length, 2);
    const first = cards.find((card) => card.getAttribute("data-path-id") === "path-linear-algebra")!;
    assert.match(first.textContent ?? "", /2 modules · 6 nodes/);
    assert.match(first.textContent ?? "", /Canonical · OSTEP/);
    assert.match(first.textContent ?? "", /1 consolidated · 2 in progress · 3 unstarted/);
    const cardBadges = (card: HTMLElement) =>
      fixture.all("mountBadge").filter((record) => card.contains(record.container));
    assert.ok(
      cardBadges(first).some((record) => record.props.text === "1 pending pivot"),
      "a pending pivot surfaces as an honest count badge",
    );
    assert.ok(
      cardBadges(first).some((record) => record.props.text === "1 unresolved error"),
      "unresolved watchpoints surface the same way",
    );
    const second = cards.find((card) => card.getAttribute("data-path-id") === "path-two")!;
    assert.match(second.textContent ?? "", /field:systems/);
    assert.doesNotMatch(pane.textContent ?? "", /%|streak|day|hour|due/i);
    assert.ok(
      fixture.root.querySelectorAll(".lp-distribution-segment").length === 6,
      "each card draws a three-segment distribution strip",
    );
    const strip = first.querySelector(".lp-distribution")!;
    assert.equal(strip.getAttribute("aria-label"), "1 consolidated · 2 in progress · 3 unstarted");
  } finally {
    fixture.restore();
  }
});

test("an empty hub keeps a single empty state and hides the overview", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    const pane = fixture.root.querySelector<HTMLElement>(".lp-overview-pane")!;
    assert.equal(pane.hidden, true, "no dashboard over zero paths");
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
    assert.equal(overviewCards(fixture.root).length, 0);
  } finally {
    fixture.restore();
  }
});

test("a card click selects that path, like the header select", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", [])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const before = fixture.calls.filter((call) => call.name === "paths.get").length;
    await cardButton(fixture, "path-two", "Path path-two").props.onClick();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.get").at(-1)?.input,
      { id: "path-two" },
    );
    const select = fixture.root.querySelector<HTMLSelectElement>(".lp-path-select")!;
    const chosen = [...select.options].find((option) => option.selected);
    assert.equal(chosen?.value, "path-two");
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Goal for path-two/);
    assert.ok(before >= 1, "the overview never bypasses the authoritative refetch");
    const selected = overviewCards(fixture.root).find((card) => card.classList.contains("lp-path-card-selected"));
    assert.equal(selected?.dataset.pathId, "path-two");
  } finally {
    fixture.restore();
  }
});

test("clicking anywhere on a card selects the path; a card's buttons keep their own action", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", [])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const card = fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-two"]')!;
    fire(card, "click");
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.get").at(-1)?.input,
      { id: "path-two" },
    );
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Goal for path-two/);
    const selected = fixture.root.querySelector<HTMLElement>(".lp-path-card-selected");
    assert.equal(selected?.getAttribute("data-path-id"), "path-two");

    // A click that lands inside a card's own button host is that button's
    // action, never an accidental path switch.
    const callsBefore = fixture.calls.filter((call) => call.name === "paths.get").length;
    fire(card.querySelector<HTMLElement>(".lp-button-host")!, "click");
    await fixture.flush();
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.get").length,
      callsBefore,
    );
  } finally {
    fixture.restore();
  }
});

test("the tag filter groups cards client-side without refetching", async () => {
  const fixture = createViewFixture({
    paths: [
      makeTaggedPath("path-exam", ["exam:step-2"]),
      makeTaggedPath("path-field", ["field:systems"]),
      makeTaggedPath("path-plain", []),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    assert.ok(filter, "the group filter mounts when any path has tags");
    assert.deepEqual(
      [...filter.options].map((option) => option.value),
      ["", "exam:step-2", "field:systems"],
    );

    const listCallsBefore = fixture.calls.filter((call) => call.name === "paths.list").length;
    setSelect(filter, "exam:step-2");
    let visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible, ["path-exam"]);
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.list").length,
      listCallsBefore,
      "grouping is a client-side filter, not another fetch",
    );

    setSelect(filter, "field:systems");
    visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible, ["path-field"]);

    setSelect(filter, "");
    visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible.sort(), ["path-exam", "path-field", "path-plain"]);
  } finally {
    fixture.restore();
  }
});

test("filtering by a tag no path carries says so instead of an empty grid", async () => {
  const fixture = createViewFixture({
    paths: [makeTaggedPath("path-a", ["exam:step-2"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    setSelect(filter, "exam:step-2");
    // Simulate the tag disappearing from every path while the filter is held.
    const { tags: _tags, ...withoutTags } = fixture.paths.get("path-a")!;
    fixture.paths.set("path-a", withoutTags);
    fixture.emit("paths-changed", { id: "path-a" });
    await fixture.flush();
    assert.match(fixture.root.textContent ?? "", /No paths carry this tag/);
    assert.ok(fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter"));
  } finally {
    fixture.restore();
  }
});

test("Edit tags saves through paths.updateMeta, refetches and renders the new filing", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const edit = cardButton(fixture, "path-linear-algebra", "Edit tags");
    await edit.props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Edit tags — Linear algebra from canon");
    const input = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-tags-input")!;
    assert.equal(input.value, "");
    input.value = "exam:step-2, field:systems";
    const save = fixture
      .all("mountButton")
      .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;
    await save.props.onClick();
    await fixture.flush();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.updateMeta").at(-1)?.input,
      { pathId: "path-linear-algebra", tags: ["exam:step-2", "field:systems"] },
    );
    assert.deepEqual(fixture.paths.get("path-linear-algebra")!.tags, ["exam:step-2", "field:systems"]);
    const card = fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-linear-algebra"]')!;
    assert.match(card.textContent ?? "", /exam:step-2/);
    assert.equal(dialog.disposed >= 1, true, "a successful save closes the dialog");
  } finally {
    fixture.restore();
  }
});

test("Edit tags shows precise inline errors and never saves invalid filing", async () => {
  const fixture = createViewFixture({
    paths: [makeTaggedPath("path-one", ["field:systems"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await cardButton(fixture, "path-one", "Edit tags").props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    const input = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-tags-input")!;
    assert.equal(input.value, "field:systems");

    const save = () =>
      fixture
        .all("mountButton")
        .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;

    input.value = "field:systems, Field:Systems";
    await save().props.onClick();
    await fixture.flush();
    assert.match(
      dialog.contentContainer!.querySelector<HTMLElement>(".lp-dialog-error")!.textContent ?? "",
      /Duplicate tag/i,
    );

    input.value = `${"x".repeat(41)}`;
    await save().props.onClick();
    await fixture.flush();
    assert.match(
      dialog.contentContainer!.querySelector<HTMLElement>(".lp-dialog-error")!.textContent ?? "",
      /at most 40 characters/i,
    );

    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.updateMeta").length,
      0,
      "invalid input never reaches the backend",
    );
    assert.equal(dialog.disposed, 0, "the dialog stays open for a correction");
    assert.deepEqual(fixture.paths.get("path-one")!.tags, ["field:systems"], "the record is untouched");
  } finally {
    fixture.restore();
  }
});

test("aborting the hub disposes every overview widget and listener", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const recordsBefore = fixture.records.length;
    const liveOverview = fixture.records.filter(
      (record) => record.container.closest(".lp-overview-pane") !== null,
    );
    assert.ok(liveOverview.length > 0, "cards own buttons and badges");

    fixture.controller.abort();
    await fixture.flush();
    assert.equal(fixture.root.childElementCount, 0);
    assert.ok(
      liveOverview.every((record) => record.disposed >= 1),
      "every overview widget is disposed through its signal",
    );
    assert.ok(recordsBefore > 0);
  } finally {
    fixture.restore();
  }
});

/* ------------------------------------------------------------------------- *
 * Many paths: the overview must stay honest and usable at 40+ paths.
 *
 * The fixture is generated, not hand-written, so the counts are arithmetic:
 * four tags across 40 paths, one in five paths untagged. Titles run opposite
 * to the updated stamps, so "Recently updated" and "Title A–Z" cannot agree by
 * accident, and two deliberate ties prove the tie-break is explicit.
 * ------------------------------------------------------------------------- */

const SCALE_TAGS = ["exam:step-2", "field:ethics", "field:systems", "project:thesis"] as const;
const SCALE_SIZE = 40;

function makeScalePaths(): LearningPath[] {
  const paths: LearningPath[] = [];
  const tiedStamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
  for (let index = 0; index < SCALE_SIZE; index += 1) {
    const base = makePath();
    const tag = SCALE_TAGS[index % 5];
    const tags = index % 5 === 4 || !tag ? [] : [tag];
    // Indices 0 and 1 share an updated stamp; indices 2 and 3 share a title.
    // Every other path varies both, with title order opposite to stamp order.
    const title =
      index === 2 || index === 3
        ? "Scale path tied"
        : `Scale path ${String(SCALE_SIZE - index).padStart(2, "0")}`;
    const updatedAt =
      index <= 1 ? tiedStamp : new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
    paths.push({
      ...base,
      id: `scale-${String(index).padStart(2, "0")}`,
      title,
      goal: `Goal for scale path ${index}.`,
      updatedAt,
      ...(tags.length === 0 ? {} : { tags }),
    });
  }
  return paths;
}

function cardIds(root: HTMLElement): string[] {
  return overviewCards(root).map((card) => card.dataset.pathId ?? "");
}

function countLine(root: HTMLElement): HTMLElement {
  const line = root.querySelector<HTMLElement>(".lp-overview-count");
  assert.ok(line, "the overview always states how many paths are on screen");
  return line;
}

test("40 paths: every card renders, tag counts are honest, and both sorts are deterministic", async () => {
  const fixture = createViewFixture({
    paths: makeScalePaths(),
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);

    // Nothing is capped, paginated or lazily hidden: 40 paths, 40 cards.
    const cards = overviewCards(fixture.root);
    assert.equal(cards.length, SCALE_SIZE);
    assert.equal(new Set(cardIds(fixture.root)).size, SCALE_SIZE);
    assert.ok(cards.every((card) => !card.hidden), "every path card is visible");
    assert.equal(countLine(fixture.root).textContent, "40 paths");

    const overviewText = fixture.root.querySelector<HTMLElement>(".lp-overview")!.textContent ?? "";
    assert.doesNotMatch(overviewText, /load more|show more|next page|page \d|pagination/i);
    // Sorting is ordering, never scheduling or prioritisation.
    assert.doesNotMatch(overviewText, /%|streak|due|hours|days|priority|stale/i);

    // Recently updated is the default: newest first, ties by title.
    const updatedOrder = cardIds(fixture.root);
    const expectedUpdated = Array.from({ length: SCALE_SIZE - 2 }, (_, offset) => SCALE_SIZE - 1 - offset);
    // Indices 39..2 by descending stamp, then the tie: "Scale path 39" before
    // "Scale path 40" (ids scale-01, scale-00).
    assert.deepEqual(updatedOrder, [...expectedUpdated.map((index) => `scale-${String(index).padStart(2, "0")}`), "scale-01", "scale-00"]);

    // The group picker states a count per entry, plus the total.
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    assert.deepEqual(
      [...filter.options].map((option) => [option.value, option.textContent]),
      [
        ["", "All paths (40)"],
        ["exam:step-2", "exam:step-2 (8)"],
        ["field:ethics", "field:ethics (8)"],
        ["field:systems", "field:systems (8)"],
        ["project:thesis", "project:thesis (8)"],
      ],
    );

    // A folder picker, when the branch has one, must show counts too.
    const folderFilter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-folder-filter");
    if (folderFilter) {
      for (const option of folderFilter.options) {
        if (option.value === "") continue;
        assert.match(option.textContent ?? "", /\(\d+\)$/, "folder entries carry their path count");
      }
    }

    // Filtering narrows the grid and the count line to the same set.
    setSelect(filter, "exam:step-2");
    const tagged = cardIds(fixture.root);
    assert.deepEqual(
      [...tagged].sort(),
      [0, 5, 10, 15, 20, 25, 30, 35].map((index) => `scale-${String(index).padStart(2, "0")}`),
    );
    assert.equal(countLine(fixture.root).textContent, "8 of 40 paths");

    // Sort still applies inside the filter: titles ascend as indices descend.
    const sort = () => fixture.root.querySelector<HTMLSelectElement>(".lp-overview-sort")!;
    setSelect(sort(), "title");
    assert.deepEqual(
      cardIds(fixture.root),
      [35, 30, 25, 20, 15, 10, 5, 0].map((index) => `scale-${String(index).padStart(2, "0")}`),
    );
    assert.equal(countLine(fixture.root).textContent, "8 of 40 paths");

    // Back to all paths: title order is total, with an explicit id tie-break.
    setSelect(fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!, "");
    const titleOrder = cardIds(fixture.root);
    assert.equal(titleOrder.length, SCALE_SIZE);
    assert.equal(titleOrder[0], "scale-39", "Scale path 01 comes first");
    assert.ok(
      titleOrder.indexOf("scale-02") < titleOrder.indexOf("scale-03"),
      "equal titles fall through to the id",
    );
    const titles = overviewCards(fixture.root).map(
      (card) => card.querySelector("button")?.textContent ?? "",
    );
    for (let index = 1; index < titles.length; index += 1) {
      assert.ok(
        titles[index - 1]!.localeCompare(titles[index]!) <= 0,
        `title order breaks at ${titles[index - 1]} → ${titles[index]}`,
      );
    }
    assert.equal(countLine(fixture.root).textContent, "40 paths");

    // Switching back reproduces the first ordering exactly: no drift, no
    // dependence on the order the previous sort left in the DOM.
    setSelect(sort(), "updated");
    assert.deepEqual(cardIds(fixture.root), updatedOrder);
    setSelect(sort(), "title");
    assert.deepEqual(cardIds(fixture.root), titleOrder);
  } finally {
    fixture.restore();
  }
});
