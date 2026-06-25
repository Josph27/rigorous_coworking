import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import { displayPlanSummary } from "../ui/summaryRenderer.js";

/**
 * Register the /status command.
 *
 * Displays current execution plan progress.
 * Automatically inhibited during high-I/O graph finishing states.
 */
export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("status", {
    description:
      "Print the current execution status and progress of the active plan.",
    handler: async (_args, ctx) => {
      await handleStatusCommand(ctx);
    },
  });
}

async function handleStatusCommand(ctx: ExtensionCommandContext): Promise<void> {
  const state = getState();

  if (state.isFinishingGraph) {
    ctx.ui.notify(
      "Status output inhibited: Agent is finalizing task I/O.",
      "warning"
    );
    return;
  }

  if (!state.activeTask) {
    ctx.ui.notify(
      "No active task. Use /task --mode={1|2|3} to start one.",
      "info"
    );
    return;
  }

  // Show current phase and lock status
  const phaseInfo = state.isLocked
    ? `🔒 VFS Locked — Phase: ${state.phase}`
    : `Phase: ${state.phase}`;
  ctx.ui.notify(
    `${phaseInfo} — Task: ${state.activeTask} | Mode: ${state.currentMode}`,
    "info"
  );

  // Render plan summary
  await displayPlanSummary(state.activeTask, ctx);
}
