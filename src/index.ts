import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answerFollowUp, DEFAULT_CONFIG, generateBriefing, loadConfig, saveConfig, resolveModels, snapshot, type BriefingConfig, type EvidenceSnapshot, type FollowUpTurn, type ResolvedModels } from "./briefing.ts";
import { createBriefingModal, briefingModalOverlayOptions, type BriefingModal, type ModalState } from "./modal.ts";

interface Latest {
  key: string;
  evidence: EvidenceSnapshot;
  models: ResolvedModels;
  briefing: string;
  discussion: FollowUpTurn[];
}
const safeErrors = new Set([
  "YSK configuration could not be read.", "YSK configuration is not valid JSON.",
  "YSK configuration must be an object.", "YSK configuration contains an unknown setting.",
  "YSK configuration could not be saved. Check the configuration directory permissions.",
  "YSK model credentials are missing. Use /login for the selected providers, then reopen /ysk.",
  "YSK setup has no models available. Update the Pi model catalog and reopen /ysk.",
  "YSK model settings must use provider/model-id values.",
  "YSK ranking model is unavailable or is not a classifier.", "YSK chat model is unavailable or is not a chat model.",
  "YSK ranking request failed.", "YSK ranking returned an invalid score.",
  "YSK chat request failed.", "YSK response attempted to use tools.", "YSK chat returned no text.",
  "YSK request timed out after 40 seconds.",
]);

const safeError = (error: unknown) => error instanceof Error && safeErrors.has(error.message)
  ? error.message : "YSK request failed. Check model availability and credentials.";

export default function youShouldKnow(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "you-should-know.json");
  let latest: Latest | undefined;
  let modal: BriefingModal | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  const cancel = () => { generation++; request?.abort(); request = undefined; };
  const clear = () => { cancel(); modal?.close(); modal = undefined; latest = undefined; };

  pi.registerCommand("ysk", {
    description: "Open a private recent-session briefing and follow-up chat",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/ysk requires interactive Pi TUI mode.");
      modal?.close();
      cancel();
      const lifetime = generation;
      let view: BriefingModal | undefined;
      let current: Latest | undefined;
      let state: ModalState = { status: "Reading recent session...", busy: true };
      let busy = false;
      let setupStage: "rank" | "chat" | "confirm" | undefined;
      let chosenRank = "";
      let chosenChat = "";
      const alive = () => lifetime === generation;
      const update = (next: ModalState) => { if (alive()) { state = next; view?.update(state); } };
      const contextStatus = (evidence: EvidenceSnapshot) => evidence.truncated
        ? `Fixed snapshot: up to 12 groups / 24,000 characters; context omitted (${evidence.omittedGroups} groups, ${evidence.omittedCharacters} characters).`
        : "Fixed session snapshot; reopen to include new output.";
      const operate = async (work: (signal: AbortSignal) => Promise<void>) => {
        if (!alive() || busy) return;
        busy = true;
        const controller = new AbortController();
        request = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let interrupted!: () => void;
        const stopped = new Promise<never>((_resolve, reject) => {
          interrupted = () => reject(new Error("YSK request was cancelled."));
          controller.signal.addEventListener("abort", interrupted, { once: true });
          timer = setTimeout(() => {
            reject(new Error("YSK request timed out after 40 seconds."));
            controller.abort();
          }, 40_000);
        });
        try { await Promise.race([work(controller.signal), stopped]); }
        catch (error) {
          if (alive()) {
            const message = safeError(error);
            update({ ...state, briefing: current?.briefing, discussion: current?.discussion ?? [], busy: false, error: message });
          }
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", interrupted);
          controller.abort();
          if (request === controller) request = undefined;
          busy = false;
        }
      };
      const modelChoices = (type: "classifier" | "chat") => ctx.modelRegistry.getModelsOfType(type).map((model) => {
        const value = `${model.provider}/${model.id}`;
        const configured = ctx.modelRegistry.getProviderAuthStatus(model.provider).configured;
        const preferred = type === "classifier" ? value === DEFAULT_CONFIG.rankModel : model.id.split("/").at(-1) === "gpt-6-luna";
        return { value, label: value, description: configured ? "Credentials configured" : `/login ${model.provider} required`,
          priority: (preferred ? 0 : 10) + (configured ? 0 : 2) + (model.provider === ctx.model?.provider ? 0 : 1) };
      }).sort((a, b) => a.priority - b.priority || a.value.localeCompare(b.value));
      const chooseStage = (stage: "rank" | "chat") => {
        const items = modelChoices(stage === "rank" ? "classifier" : "chat");
        if (!items.length) throw new Error("YSK setup has no models available. Update the Pi model catalog and reopen /ysk.");
        setupStage = stage;
        update({ busy: false, status: "Choose your models. No model calls run during setup.", setup: {
          title: stage === "rank" ? "1/3 · Ranking model" : "2/3 · Briefing and follow-up model", items,
        } });
      };
      const runBriefing = async (config: BriefingConfig, signal: AbortSignal) => {
        if (!alive() || signal.aborted) return;
        const evidence = snapshot(ctx);
        if (!evidence.groups.length) { update({ empty: true, busy: false }); return; }
        const models = resolveModels(ctx, config);
        if (![models.rankModel, models.chatModel].every((model) => ctx.modelRegistry.getProviderAuthStatus(model.provider).configured)) {
          const providers = [...new Set([models.rankModel.provider, models.chatModel.provider])]
            .filter((provider) => !ctx.modelRegistry.getProviderAuthStatus(provider).configured);
          update({ busy: false, error: "YSK model credentials are missing. Use /login for the selected providers, then reopen /ysk.",
            notice: `Ranking: ${config.rankModel}\n\nChat: ${config.chatModel}\n\nClose this modal and run ${providers.map((provider) => `\`/login ${provider}\``).join(" and ")} in Pi. Your model settings are already saved.` });
          return;
        }
        const key = JSON.stringify({ evidence, config });
        if (latest?.evidence.sessionId !== evidence.sessionId) latest = undefined;
        if (latest?.key === key) {
          current = latest;
          update({ briefing: current.briefing, discussion: current.discussion, status: contextStatus(evidence), busy: false });
          return;
        }
        update({ busy: true, status: "Ranking and writing recent session..." });
        const result = await generateBriefing(ctx, models, evidence, signal, {
          previousBriefing: latest?.briefing,
          onText: (text) => { if (!signal.aborted) update({ briefing: text, busy: true, status: contextStatus(evidence) }); },
        });
        if (!alive() || signal.aborted) return;
        latest = current = { key, evidence, models, briefing: result.text, discussion: [] };
        update({ briefing: result.text, discussion: [], busy: false, status: contextStatus(evidence) });
      };
      const start = () => void operate(async (signal) => {
        const config = await loadConfig(path);
        if (!alive() || signal.aborted) return;
        if (!config) { chooseStage("rank"); return; }
        await runBriefing(config, signal);
      });
      const setupSelect = (value: string) => {
        if (!alive() || busy || !state.setup?.items.some((item) => item.value === value)) return;
        if (setupStage === "rank") {
          chosenRank = value;
          try { chooseStage("chat"); }
          catch (error) { update({ busy: false, error: safeError(error) }); }
        } else if (setupStage === "chat") {
          chosenChat = value;
          setupStage = "confirm";
          update({ busy: false, setup: {
            title: "3/3 · Save configuration", searchable: false,
            summary: `Ranking: ${chosenRank}\n\nChat: ${chosenChat}\n\nSettings: ${path}\n\nOnly model IDs are saved. Briefings and discussion stay private.`,
            items: [{ value: "save", label: "Save and generate briefing" }],
          } });
        } else if (setupStage === "confirm" && value === "save") {
          void operate(async (signal) => {
            const config = { rankModel: chosenRank, chatModel: chosenChat };
            resolveModels(ctx, config);
            update({ ...state, busy: true, status: "Saving model settings..." });
            const stored = await saveConfig(path, config, signal);
            if (!alive() || signal.aborted) return;
            setupStage = undefined;
            if (stored.rankModel !== config.rankModel || stored.chatModel !== config.chatModel) {
              update({ busy: false, error: "Another session saved different model settings. They were kept. Reopen /ysk to use them.",
                notice: `Ranking: ${stored.rankModel}\n\nChat: ${stored.chatModel}` });
              return;
            }
            await runBriefing(stored, signal);
          });
        }
      };
      const submit = (question: string) => {
        if (!question.trim() || !current || busy || !alive()) return;
        const captured = current;
        const pending: FollowUpTurn = { role: "user", text: question.trim().slice(0, 8_000) };
        void operate(async (signal) => {
          update({ briefing: captured.briefing, discussion: [...captured.discussion, pending], busy: true, status: "Answering from the fixed snapshot..." });
          const answer = await answerFollowUp(ctx, captured.models.chatModel, captured.evidence, captured.briefing, pending.text, captured.discussion, signal, (text) => {
            if (!signal.aborted) update({ ...state, discussion: [...captured.discussion, pending, { role: "assistant", text }] });
          });
          if (!alive() || signal.aborted) return;
          captured.discussion = [...captured.discussion, pending, { role: "assistant", text: answer.slice(0, 8_000) }].slice(-8) as FollowUpTurn[];
          update({ briefing: captured.briefing, discussion: captured.discussion, busy: false, status: contextStatus(captured.evidence) });
        });
      };
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          view = createBriefingModal(tui, theme, keys, done, { onSubmit: submit, onSetupSelect: setupSelect, onCancel: () => { if (alive()) cancel(); } }, state);
          modal = view;
          return view;
        }, { overlay: true, overlayOptions: briefingModalOverlayOptions(), onHandle: start });
      } finally {
        if (alive()) cancel();
        view?.dispose();
        if (modal === view) modal = undefined;
      }
    },
  });
  pi.on("session_start", clear);
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);
}
