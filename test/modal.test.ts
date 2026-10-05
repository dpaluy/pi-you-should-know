import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, type KeybindingsManager, type TUI, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BriefingModal, type ModalState } from "../src/modal.ts";

initTheme();

function makeModal(initial: ModalState = { status: "Reading recent session...", busy: true }) {
  let submitted: string[] = [];
  const configured: string[] = [];
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
    onSetupSelect: (value) => configured.push(value),
    onCancel: () => { cancelled++; },
  }, initial);
  return { modal, tui, submitted, configured, get cancelled() { return cancelled; }, get completed() { return completed; }, get renders() { return renders; } };
}

test("renders the private status and briefing in narrow and short terminal bounds", () => {
  const { modal, tui } = makeModal({ briefing: "# Point\n\nA useful discovery.", discussion: [], status: "Ready" });
  const narrow = modal.render(13);
  assert.ok(narrow.length <= 15);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 13));
  assert.ok(narrow.join("\n").includes("Point"));
  assert.ok(narrow.some((line) => line.includes(CURSOR_MARKER)), "focused input emits the native cursor marker");
  modal.update({ empty: true });
  (tui.terminal as unknown as { rows: number }).rows = 4;
  const short = modal.render(20);
  assert.ok(short.length <= 4);
  assert.ok(short.join("\n").includes("No session"));
});

test("frames and pads the answer, with a separate padded follow-up area", () => {
  const { modal, tui } = makeModal({
    briefing: "Short briefing.",
    discussion: [{ role: "user", text: "Why?" }, { role: "assistant", text: "Use the local result." }],
  });
  (tui.terminal as unknown as { rows: number }).rows = 30;
  const lines = modal.render(60);
  const plain = lines.map(stripTerminalSequences);
  assert.ok(plain[0].startsWith("╭") && plain[0].endsWith("╮"));
  assert.ok(plain.at(-1)!.startsWith("╰") && plain.at(-1)!.endsWith("╯"));
  assert.ok(lines.every((line) => visibleWidth(line) === 60), "the frame closes at a fixed column");
  assert.match(plain[1], /^│ +│$/, "blank top padding separates the content from the border");
  const answer = plain.findIndex((line) => line.includes("Use the local result."));
  assert.ok(answer > 0);
  assert.ok(plain[answer].startsWith("│  ") && plain[answer].endsWith("  │"));
  const divider = plain.findIndex((line) => line.startsWith("├") && line.includes("Follow-up"));
  assert.ok(divider > answer, "the answer stays above the follow-up separator");
  assert.ok(plain.slice(answer + 1, divider).some((line) => /^│ +│$/.test(line)), "blank space follows the answer");
  assert.match(plain[divider + 1], /^│ +│$/, "blank space separates the divider and input");
  assert.ok(lines[divider + 2].includes(CURSOR_MARKER), "the padded input preserves the native cursor");
  assert.match(plain[divider + 2], /^│  › /);
  const frame = [plain[0], plain[divider], plain.at(-1)];
  modal.scrollBy(10_000);
  const scrolled = modal.render(60).map(stripTerminalSequences);
  assert.deepEqual([scrolled[0], scrolled.find((line) => line.startsWith("├")), scrolled.at(-1)], frame);
});

test("keeps the frame within terminal bounds after narrow and short resizes", () => {
  const { modal, tui } = makeModal({ briefing: "界 wide characters and a long response ".repeat(30), status: "Ready" });
  for (const rows of [1, 4, 6, 9, 15, 30]) {
    (tui.terminal as unknown as { rows: number }).rows = rows;
    for (const width of [1, 2, 5, 13, 40, 60]) {
      const lines = modal.render(width);
      assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.85)), `height at ${width}x${rows}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `width at ${width}x${rows}`);
      if (width >= 3 && lines.length >= 2) {
        const last = stripTerminalSequences(lines.at(-1)!);
        assert.ok(last.startsWith("╰") && last.endsWith("╯"), "bottom border survives clipping");
      }
    }
  }
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
  const fixedControls = (view: string) => {
    const lines = view.split("\n");
    const divider = lines.findIndex((line) => stripTerminalSequences(line).startsWith("├"));
    return [lines[0], ...lines.slice(divider)];
  };
  assert.deepEqual(fixedControls(moved), fixedControls(top), "scrolling leaves the frame and follow-up controls in place");
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

test("first-run model picker filters, uses native selection keys, and blocks busy submissions", () => {
  const setup = { title: "Ranking model", items: [
    { value: "typesafe/jev-latest", label: "typesafe/jev-latest" },
    { value: "fixture/other", label: "fixture/other" },
  ] };
  const harness = makeModal({ setup });
  const initial = harness.modal.render(60);
  assert.ok(initial.some((line) => line.includes(CURSOR_MARKER)), "search has native input focus");
  harness.modal.handleInput("\x1b[B"); harness.modal.handleInput("\r");
  assert.deepEqual(harness.configured, ["fixture/other"]);
  for (const character of "jev") harness.modal.handleInput(character);
  const filtered = harness.modal.render(60).join("\n");
  assert.match(filtered, /jev-latest/);
  assert.doesNotMatch(filtered, /fixture\/other/);
  harness.modal.handleInput("\r");
  assert.deepEqual(harness.configured, ["fixture/other", "typesafe/jev-latest"]);
  assert.deepEqual(harness.submitted, [], "setup input cannot become a follow-up question");
  harness.modal.update({ setup, busy: true });
  harness.modal.handleInput("\r");
  assert.equal(harness.configured.length, 2);
  for (const rows of [4, 9, 15, 30]) {
    (harness.tui.terminal as unknown as { rows: number }).rows = rows;
    for (const width of [2, 13, 40, 60]) {
      const lines = harness.modal.render(width);
      assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.85)));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
  harness.modal.handleInput("\x1b"); harness.modal.handleInput("\r");
  assert.equal(harness.configured.length, 2);
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
