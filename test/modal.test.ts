import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BriefingModal, type ModalState } from "../src/modal.ts";

initTheme();

function makeModal(initial: ModalState = { status: "Reading recent session...", busy: true }) {
  let submitted: string[] = [];
  let cancelled = 0;
  let completed = 0;
  let renders = 0;
  const tui = {
    terminal: { rows: 15, columns: 60 },
    requestRender: () => { renders++; },
  } as unknown as TUI;
  const theme = {
    fg: (_token: string, text: string) => text,
  } as any;
  const keybindings = { matches: () => false } as unknown as KeybindingsManager;
  const modal = new BriefingModal(tui, theme, keybindings, () => { completed++; }, {
    onSubmit: (question) => submitted.push(question),
    onCancel: () => { cancelled++; },
  }, initial);
  return { modal, tui, submitted, get cancelled() { return cancelled; }, get completed() { return completed; }, get renders() { return renders; } };
}

test("renders the private status and briefing in narrow and short terminal bounds", () => {
  const { modal, tui } = makeModal({ briefing: "# Key point\n\nA useful discovery.", discussion: [], status: "Ready" });
  const narrow = modal.render(13);
  assert.ok(narrow.length <= 15);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 13));
  assert.ok(narrow.join("\n").includes("Key point"));
  assert.ok(narrow.some((line) => line.includes(CURSOR_MARKER)), "focused input emits the native cursor marker");
  modal.update({ empty: true });
  (tui.terminal as unknown as { rows: number }).rows = 4;
  const short = modal.render(20);
  assert.ok(short.length <= 4);
  assert.ok(short.join("\n").includes("No session"));
});

test("uses native input to submit only nonempty questions when a briefing is ready", () => {
  const harness = makeModal({ briefing: "Relevant evidence", discussion: [] });
  const input = (value: string) => {
    for (const char of value) harness.modal.handleInput(char);
    harness.modal.handleInput("\r");
  };
  harness.modal.handleInput("\r");
  assert.deepEqual(harness.submitted, []);
  input("  Why?  ");
  assert.deepEqual(harness.submitted, ["Why?"]);
  harness.modal.update({ briefing: "Relevant evidence", busy: true });
  input("another");
  assert.deepEqual(harness.submitted, ["Why?"]);
});

test("scrolls native scroll view and refreshes rendering", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n\n");
  const harness = makeModal({ briefing: text });
  const top = harness.modal.render(40).join("\n");
  assert.match(top, /Line 1\b/);
  harness.modal.scrollBy(5);
  const moved = harness.modal.render(40).join("\n");
  assert.ok(harness.modal.scrollTop > 0, "native ScrollView advances its viewport");
  assert.notEqual(moved, top, "scrolling changes the visible content, not only the counter");
  assert.doesNotMatch(moved, /Line 1\b/);
  assert.equal(harness.modal.render(40).length <= 15, true);
  harness.modal.scrollBy(-10_000);
  assert.equal(harness.modal.render(40).join("\n"), top);
  harness.modal.handleInput("draft");
  harness.modal.handleInput("\x1b[6~");
  assert.ok(harness.modal.scrollTop > 0, "Page Down scrolls without editing the question");
  assert.doesNotMatch(harness.modal.render(40).join("\n"), /Line 1\b/);
  harness.modal.handleInput("\x1b[5~");
  assert.match(harness.modal.render(40).join("\n"), /Line 1\b/);
  harness.modal.handleInput("\r");
  assert.deepEqual(harness.submitted, ["draft"]);
  harness.modal.handleMouse({ type: "wheel", button: "none", x: 1, y: 3, screenX: 1, screenY: 3, width: 40, height: 15, shift: false, ctrl: false, alt: false, wheelDelta: 8 });
  assert.doesNotMatch(harness.modal.render(40).join("\n"), /Line 1\b/);
  assert.ok(harness.renders >= 2);
});

test("Escape closes once and disposed callbacks cannot submit or refresh", () => {
  const harness = makeModal({ briefing: "Ready" });
  harness.modal.handleInput("\x1b");
  assert.equal(harness.cancelled, 1);
  assert.equal(harness.completed, 1);
  harness.modal.handleInput("x");
  harness.modal.update({ briefing: "Stale response" });
  harness.modal.refresh();
  assert.deepEqual(harness.submitted, []);
  assert.equal(harness.renders, 0);
  assert.deepEqual(harness.modal.render(50), []);
});
