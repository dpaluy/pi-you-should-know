import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Input,
  Markdown,
  ScrollView,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface ModalState {
  readonly status?: string;
  readonly briefing?: string;
  readonly discussion?: readonly { role: "user" | "assistant"; text: string }[];
  readonly error?: string;
  readonly empty?: boolean;
  readonly busy?: boolean;
}

export interface ModalCallbacks {
  onSubmit(question: string): void;
  onCancel(): void;
}

/** Private, controller-driven TUI view for /ysk. It makes no provider or session calls. */
export class BriefingModal implements Component, Focusable {
  focused = true;
  private state: ModalState;
  private disposed = false;
  private readonly input = new Input({ prompt: "› ", placeholder: "Ask about this briefing..." });
  private readonly content: Markdown;
  private readonly scroll: ScrollView;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly callbacks: ModalCallbacks;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: () => void,
    callbacks: ModalCallbacks,
    initialState: ModalState = { status: "Reading recent session...", busy: true },
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.callbacks = callbacks;
    this.state = initialState;
    this.input.onSubmit = (value) => this.submit(value);
    this.content = new Markdown(this.bodyText(), 0, 0, getMarkdownTheme());
    this.scroll = new ScrollView(this.content, { axis: "vertical", follow: "none", primary: true, scrollbar: "auto" });
  }

  update(state: ModalState): void {
    if (this.disposed) return;
    this.state = { ...state, discussion: state.discussion ? [...state.discussion] : [] };
    this.content.setText(this.bodyText());
    this.invalidate();
    this.tui.requestRender();
  }

  get scrollTop(): number {
    return this.scroll.scrollTop;
  }

  scrollBy(lines: number): void {
    if (this.disposed) return;
    this.scroll.scrollBy(lines);
    this.tui.requestRender();
  }

  refresh(): void {
    if (this.disposed) return;
    this.content.setText(this.bodyText());
    this.invalidate();
    this.tui.requestRender();
  }

  /** Completes the custom UI interaction and disposes this view. */
  close(): void {
    if (this.disposed) return;
    this.callbacks.onCancel();
    this.done();
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.focused = false;
    this.scroll.setScrollbar("hidden");
  }

  invalidate(): void {
    this.content.invalidate();
    this.scroll.invalidate();
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
      return;
    }
    if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
      return;
    }
    this.input.focused = this.focused;
    this.input.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return;
    if (event.type === "wheel") {
      this.scrollBy(event.wheelDelta ?? 0);
      return { handled: true };
    }
    return this.scroll.handleMouse(event);
  }

  render(width: number): string[] {
    if (this.disposed || width <= 0) return [];
    const terminalHeight = Math.max(1, this.tui.terminal.rows);
    const panelWidth = Math.max(1, Math.min(width, this.tui.terminal.columns || width));
    const height = Math.min(terminalHeight, Math.max(1, Math.floor(terminalHeight * 0.85)));
    if (panelWidth < 3) return [this.fit("│", panelWidth)];
    const frameWidth = panelWidth - 2;
    const paddingX = Math.min(2, Math.max(0, Math.floor((frameWidth - 1) / 2)));
    const innerWidth = Math.max(1, frameWidth - paddingX * 2);
    const paddingY = height >= 14 ? 1 : 0;
    const edge = (left: string, right: string, label = "") => {
      const title = truncateToWidth(label, frameWidth, "");
      return this.theme.fg("border", left) + this.theme.fg("accent", title) +
        this.theme.fg("border", "─".repeat(Math.max(0, frameWidth - visibleWidth(title))) + right);
    };
    const row = (line: string) => this.theme.fg("border", "│") +
      truncateToWidth(line, frameWidth, "…", true) + this.theme.fg("border", "│");
    const padded = (lines: string[]) => {
      const box = new Box(paddingX, paddingY);
      box.addChild({ render: () => lines, invalidate() {} });
      return box.render(frameWidth).map(row);
    };
    const top = edge("╭", "╮", ` You should know · ${this.state.busy ? "Working" : "Private"} `);
    const bottom = edge("╰", "╯");
    const status = this.state.error
      ? this.theme.fg("error", this.state.error)
      : this.state.empty
        ? this.theme.fg("muted", "No session output to review")
        : this.state.status
          ? this.theme.fg("muted", this.state.status)
          : "";
    if (height <= 6) {
      const content = status || this.content.render(frameWidth)[0] || "";
      return height === 1 ? [top] : height === 2 ? [top, bottom] : [top, row(content), bottom];
    }
    const statusLines = status ? [truncateToWidth(status, innerWidth, "…")] : [];
    if (status && height >= 10) statusLines.push("");
    const footerText = this.state.briefing && !this.state.empty
      ? (this.state.busy ? "Working · PgUp/PgDn scroll · Escape closes" : "Enter asks · PgUp/PgDn scroll · Escape closes")
      : "Escape closes";
    const footerLines = [truncateToWidth(this.theme.fg("muted", footerText), innerWidth, "…")];
    this.input.focused = this.focused;
    const inputLines = this.state.briefing && !this.state.empty && height >= 7
      ? this.input.render(innerWidth).slice(0, 1)
      : [];
    // Keep the composer outside the scroll viewport, with its own separator and padding.
    const composer = inputLines.length
      ? [edge("├", "┤", " Follow-up "), ...padded([...inputLines, ...footerLines])]
      : [];
    const tail = inputLines.length ? [] : ["", ...footerLines];
    const fixed = 2 + paddingY * 2 + statusLines.length + composer.length + tail.length;
    const bodyHeight = Math.max(0, height - fixed);
    const bodyLines = this.content.render(innerWidth);
    this.scroll.updateLayout(bodyLines.length, bodyHeight, () => { if (!this.disposed) this.tui.requestRender(); });
    // ScrollView.render() supplies unbounded child lines. Apply its public viewport state
    // here because this custom overlay renders flat lines rather than a layout tree.
    const body = bodyHeight ? this.scroll.render(innerWidth).slice(this.scroll.scrollTop, this.scroll.scrollTop + bodyHeight) : [];
    return [top, ...padded([...statusLines, ...body, ...tail]), ...composer, bottom];
  }

  private bodyText(): string {
    const sections: string[] = [];
    if (this.state.briefing) sections.push(this.state.briefing);
    for (const turn of this.state.discussion ?? []) {
      sections.push(`**${turn.role === "user" ? "You" : "YSK"}**\n\n${turn.text}`);
    }
    return sections.join("\n\n---\n\n");
  }

  private fit(text: string, width: number): string {
    // Keep output width safe even for status strings carrying ANSI styles.
    return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
  }

  private submit(value: string): void {
    const question = value.trim();
    if (this.disposed || !question) return;
    this.input.setValue("");
    if (this.state.busy || !this.state.briefing || this.state.empty) return;
    this.callbacks.onSubmit(question);
  }
}

/** Build a visible overlay before the caller starts asynchronous configuration/provider work. */
export function createBriefingModal(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: void) => void,
  callbacks: ModalCallbacks,
  initialState?: ModalState,
): BriefingModal {
  return new BriefingModal(tui, theme, keybindings, () => done(), callbacks, initialState);
}

export function briefingModalOverlayOptions() {
  return {
    width: "85%" as const,
    minWidth: 1,
    maxHeight: "85%" as const,
    anchor: "center" as const,
    margin: 1,
  };
}
