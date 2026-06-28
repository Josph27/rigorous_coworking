import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState, resetState } from "../state.js";
import { unlockWorkspace } from "../vfs/lockManager.js";

export function registerHaltCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task-halt", {
    description: "Deactivate the current task and return to normal chat mode.",
    handler: async (_args, ctx) => {
      const state = getState();

      if (!state.activeTask) {
        ctx.ui.notify("No active task to halt.", "info");
        return;
      }

      const taskName = state.activeTask;
      unlockWorkspace();
      resetState();

      ctx.ui.notify(
        `Task "${taskName}" halted. VFS unlocked. Normal chat mode. Use /task-resume to continue later.`,
        "info"
      );
    },
  });
}
