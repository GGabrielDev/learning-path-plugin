/** Roadmap lane view tests.
 *
 * Mounted through the real Path Hub: the tree ↔ roadmap toggle appears only
 * for multi-module paths, lanes render only recorded structure (no arrows,
 * dates or order pressure), cards select nodes into the same inspector, and
 * everything disposes with the hub. No browser or model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation } from "./view-host.ts";

function snapshot(id: string) {
  return makeConversation(id);
}

/** `makePath` with the second module dropped, to model a one-module path. */
function singleModulePath(): LearningPath {
  const path = makePath();
  return { ...path, modules: [path.modules[0]!] };
}

async function mounted(fixture: ReturnType<typeof createViewFixture>): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

function roadmapButton(fixture: ReturnType<typeof createViewFixture>) {
  const record = fixture
    .all("mountButton")
    .find((entry) => entry.props.label === "Roadmap view" || entry.props.label === "Tree view");
  assert.ok(record, "the view toggle is mounted");
  return record;
}

function cardAt(root: HTMLElement, laneIndex: number, cardIndex: number): HTMLElement {
  const lane = root.querySelectorAll<HTMLElement>(".lp-lane")[laneIndex];
  assert.ok(lane, `Missing lane ${laneIndex}`);
  const card = lane.querySelectorAll<HTMLElement>(".lp-roadmap-card")[cardIndex];
  assert.ok(card, `Missing card ${cardIndex} in lane ${laneIndex}`);
  return card;
}

test("a one-module path offers no roadmap toggle; the multi-module path does", async () => {
  const single = createViewFixture({
    paths: [singleModulePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(single);
    const hiddenToggle = single
      .all("mountButton")
      .find((entry) => entry.props.label === "Roadmap view");
    assert.ok(hiddenToggle, "the toggle is mounted for consistent widget state");
    assert.equal(
      hiddenToggle.container.hidden,
      true,
      "a single lane is not a roadmap; the toggle stays hidden",
    );
  } finally {
    single.restore();
  }

  const multi = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(multi);
    const button = roadmapButton(multi);
    assert.equal(button.props.variant, "outline");
    assert.equal(button.container.hidden, false);
    assert.equal(button.props.label, "Roadmap view");
  } finally {
    multi.restore();
  }
});

test("the roadmap renders module lanes and node cards from recorded structure only", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await roadmapButton(fixture).props.onClick();
    await fixture.flush();

    assert.equal(fixture.all("mountTree").length, 0, "the tree widget is released in roadmap mode");
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-tree-pane .lp-pane-title")!.textContent ?? "",
      /Path roadmap/,
    );

    const lanes = fixture.root.querySelectorAll<HTMLElement>(".lp-lane");
    assert.equal(lanes.length, 2);
    assert.match(lanes[0]!.textContent ?? "", /Structure first/);
    assert.match(lanes[0]!.textContent ?? "", /1\/3 consolidated/);
    assert.match(lanes[1]!.textContent ?? "", /Synthesis/);
    assert.match(lanes[1]!.textContent ?? "", /0\/3 consolidated/);

    const firstCard = cardAt(fixture.root, 0, 0);
    assert.match(firstCard.textContent ?? "", /Node n-holistic/);
    assert.match(firstCard.textContent ?? "", /OSTEP — chapter 26, section 27\.1, pages 301-320/);
    const secondCard = cardAt(fixture.root, 0, 1);
    assert.match(secondCard.textContent ?? "", /1 teaching/);

    const cardBadges = fixture
      .all("mountBadge")
      .filter((badge) => secondCard.contains(badge.container))
      .map((badge) => badge.props.text);
    assert.deepEqual(cardBadges, ["Concept", "In progress"]);

    const wholeBoard = fixture.root.querySelector<HTMLElement>(".lp-roadmap")!.textContent ?? "";
    assert.doesNotMatch(wholeBoard, /%|streak|day|hour|due|next up/i, "no scheduling or ordering pressure");
    assert.doesNotMatch(wholeBoard, /→|→/, "no drawn prerequisite edges");
  } finally {
    fixture.restore();
  }
});

test("a card click selects the node into the shared inspector and marks the card", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await roadmapButton(fixture).props.onClick();
    await fixture.flush();

    const card = cardAt(fixture.root, 1, 1);
    assert.equal(card.getAttribute("aria-pressed"), "false");
    fire(card, "click");
    await fixture.flush();

    const inspector = fixture.root.querySelector<HTMLElement>(".lp-inspector")!;
    assert.equal(inspector.dataset.nodeId, "n-checkpoint");
    const selected = fixture.root.querySelectorAll<HTMLElement>(".lp-roadmap-card-selected");
    assert.equal(selected.length, 1);
    assert.match(selected[0]!.textContent ?? "", /Node n-checkpoint/);
    assert.equal(selected[0]!.getAttribute("aria-pressed"), "true");
    assert.match(inspector.textContent ?? "", /Node n-checkpoint/);
  } finally {
    fixture.restore();
  }
});

test("toggles return to the tree and re-render without leaking the roadmap DOM", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await roadmapButton(fixture).props.onClick();
    await fixture.flush();
    assert.ok(fixture.root.querySelector(".lp-roadmap"));

    const back = fixture
      .all("mountButton")
      .find((entry) => entry.props.label === "Tree view")!;
    assert.equal(back.props.variant, "secondary", "the active mode reads as on");
    await back.props.onClick();
    await fixture.flush();

    const tree = fixture.find("mountTree");
    assert.equal(tree.props.label, "Path hierarchy");
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-tree-pane .lp-pane-title")!.textContent ?? "",
      /Path tree/,
    );
    assert.equal(fixture.root.querySelector(".lp-roadmap"), null, "the roadmap DOM is removed");
    assert.equal(fixture.root.querySelectorAll(".lp-roadmap-card").length, 0);
    assert.equal(
      fixture.all("mountBadge").every((badge) => badge.container.closest(".lp-roadmap") === null),
      true,
    );
  } finally {
    fixture.restore();
  }
});

test("aborting the hub while the roadmap is showing disposes its badges and DOM", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await roadmapButton(fixture).props.onClick();
    await fixture.flush();
    const roadmapBadges = fixture
      .all("mountBadge")
      .filter((badge) => badge.container.closest(".lp-roadmap") !== null);
    assert.ok(roadmapBadges.length >= 12, "every node carries type and progression badges");

    fixture.controller.abort();
    await fixture.flush();
    assert.equal(fixture.root.childElementCount, 0);
    assert.ok(
      roadmapBadges.every((badge) => badge.disposed >= 1),
      "roadmap badges are disposed through their signal",
    );
  } finally {
    fixture.restore();
  }
});
