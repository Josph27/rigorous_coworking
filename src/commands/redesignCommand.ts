import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import { lockWorkspace } from "../vfs/lockManager.js";
import { formatPlanSummary } from "../ui/summaryRenderer.js";
import { loadPlanGraph } from "../tools/plannerTools.js";

export function registerRedesignCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task-redesign", {
    description: "Re-enter planning for remaining (incomplete) steps only.",
    handler: async (_args, ctx) => {
      const state = getState();
      if (!state.activeTask) {
        ctx.ui.notify("No active task.", "warning");
        return;
      }

      const plan = await loadPlanGraph(state.activeTask, ctx.cwd);
      if (!plan) {
        ctx.ui.notify("No plan found.", "error");
        return;
      }

      const completed = plan.steps.filter((s) => s.is_completed);
      const remaining = plan.steps.filter((s) => !s.is_completed);

      if (remaining.length === 0) {
        ctx.ui.notify("All steps already complete.", "info");
        return;
      }

      // Lock VFS for redesign
      lockWorkspace(state.activeTask);
      plan.status = "designing";
      state.planGraph = plan;
      state.phase = "plan_review";

      ctx.ui.notify(
        `Redesign: ${completed.length} step(s) locked, ${remaining.length} step(s) open for revision.`,
        "info"
      );

      // Show current state
      ctx.ui.notify(formatPlanSummary(plan, state.activeTask), "info");

      // Send redesign prompt — locked steps are marked is_completed, agent must keep them
      pi.sendUserMessage(
        `[SYSTEM: Plan Designer — Redesign Remaining Steps]\n\n` +
          `TASK: ${state.activeTask}\n\n` +
          `COMPLETED STEPS (LOCKED — DO NOT MODIFY):\n` +
          completed
            .map((s) => `  Step ${s.step_id}: ${s.headline} [✓]`)
            .join("\n") +
          `\n\nREMAINING STEPS (OPEN FOR REVISION):\n` +
          remaining
            .map((s) => `  Step ${s.step_id}: ${s.headline} [ ]`)
            .join("\n") +
          `\n\nYou may modify, reorder, add, or remove the REMAINING steps. ` +
          `COMPLETED steps must remain unchanged. Use mutate_plan_graph to update. ` +
          `Keep completed steps exactly as-is with is_completed: true.`,
        { deliverAs: "followUp", triggerTurn: true }
      );
    },
  });
}
