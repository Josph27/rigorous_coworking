import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import { lockWorkspace } from "../vfs/lockManager.js";
import { loadPlanGraph } from "../tools/plannerTools.js";
import { buildOmbudsmanPrompt } from "../ombudsman/ombudsman.js";
import { formatPlanSummary } from "../ui/summaryRenderer.js";

export function registerExtendCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task-extend", {
    description:
      'Extend the current task with additional requirements. Usage: /task-extend "description of extension". Runs through Ombudsman → Planner → Execution.',
    handler: async (args, ctx) => {
      const raw = typeof args === "string" ? args : String(args ?? "");
      const state = getState();

      if (!state.activeTask) {
        ctx.ui.notify("No active task. Use /task or /task-resume first.", "warning");
        return;
      }

      const plan = await loadPlanGraph(state.activeTask, ctx.cwd);
      if (!plan) {
        ctx.ui.notify("No plan found for current task.", "error");
        return;
      }

      // Extract extension description
      const descMatch = raw.match(/^"([^"]+)"/);
      const description = descMatch ? descMatch[1].trim() : raw.trim();
      if (!description) {
        ctx.ui.notify(
          'Usage: /task-extend "add dark mode support throughout the app"',
          "error"
        );
        return;
      }

      // Build extension assignment
      const completed = plan.steps.filter((s) => s.is_completed);
      const extensionAssignment =
        `# Task Extension: ${state.activeTask}\n\n` +
        `**Mode:** ${state.currentMode ?? 1}\n\n` +
        `## Previously Completed\n\n` +
        completed
          .map((s) => `- Step ${s.step_id}: ${s.headline} [✓]`)
          .join("\n") +
        `\n\n## Extension Request\n\n${description}\n\n` +
        `## Completeness Conditions\n\n_To be refined by Ombudsman._\n`;

      // Lock VFS and start ombudsman
      lockWorkspace(state.activeTask);
      state.phase = "ombudsman_analyzing";
      state.ombudsmanIterations = 0;
      state.gapRoundHistory = [];
      state._ombudsmanRound = 0;
      state._earlyGreenlight = false;
      state.assignmentText = extensionAssignment;

      ctx.ui.notify(
        `Extending "${state.activeTask}" — Ombudsman analyzing extension.`,
        "info"
      );
      ctx.ui.notify(
        `${completed.length} existing step(s) preserved.`,
        "info"
      );

      // Also update the plan designer prompt for when ombudsman completes:
      // we'll hook into the normal triggerPlanDesigner, but we need to tell it
      // to APPEND new steps, not replace. Store a flag for the orchestrator.
      state._extendMode = true;

      pi.sendUserMessage(buildOmbudsmanPrompt(extensionAssignment, state.activeTask!), {
        deliverAs: "followUp",
        triggerTurn: true,
      });
    },
  });
}
