import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import type { CoworkMode } from "../types/schema.js";

const MODE_LABELS: Record<number, string> = {
  0: "Stepwise (halt every step)",
  1: "Semi-auto (halt on failure / stop points)",
  2: "Continuous (halt on alarms / stop points)",
  3: "Silent (fully autonomous)",
};

export function registerModeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task-mode", {
    description: "Switch coworking mode during execution. /task-mode=0|1|2|3",
    handler: async (args, ctx) => {
      const raw = typeof args === "string" ? args : String(args ?? "");
      const match = raw.match(/[= ]?([0123])/);
      if (!match) {
        ctx.ui.notify(
          "Usage: /task-mode=0|1|2|3\n" +
          "  0 = stepwise,  1 = semi-auto,  2 = continuous,  3 = silent",
          "error"
        );
        return;
      }
      const mode = parseInt(match[1], 10) as CoworkMode;
      const state = getState();

      if (!state.activeTask) {
        ctx.ui.notify("No active task.", "warning");
        return;
      }

      const prev = state.currentMode;
      state.currentMode = mode;

      ctx.ui.notify(
        `Mode: ${prev ?? "?"} → ${mode} (${MODE_LABELS[mode] ?? mode})`,
        "info"
      );

      // If switching out of stepwise while waiting for greenlight, auto-advance
      if (prev === 0 && state.waitingForGreenlight && mode !== 0) {
        state.waitingForGreenlight = false;
        state.currentStepIndex++;
        ctx.ui.notify("Auto-advancing: mode switch released greenlight gate.", "info");
      }
    },
  });
}
