/**
 * Rigorous Coworking Harness Extension
 *
 * A pi coding agent extension implementing a strict state-machine-based
 * planning and execution framework with three coworking modes.
 *
 * State Machine Phases:
 *   idle → ombudsman_analyzing → ombudsman_modal (loop) → planning →
 *   plan_review → executing → finished
 *
 * Modes:
 *   Mode 1 (Stepwise):    Execute one step at a time, halting for /greenlight
 *   Mode 2 (Continuous):  Execute all steps automatically with complexity alarms
 *   Mode 3 (Silent):      Fully autonomous with upfront cost gating
 *
 * Commands:
 *   /task --mode={1|2|3} "name": description  — Start a task
 *   /greenlight   — Approve plan / advance step / acknowledge exception
 *   /status       — Poll current execution progress
 *
 * Tools:
 *   mutate_plan_graph  — Exclusive LLM tool for plan mutations (enforced by VFS lock)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskCommand } from "./commands/taskCommand.js";
import { registerGreenlightCommand } from "./commands/greenlightCommand.js";
import { registerStatusCommand } from "./commands/statusCommand.js";
import { registerResumeCommand } from "./commands/resumeCommand.js";
import { registerModeCommand } from "./commands/modeCommand.js";
import { registerRedesignCommand } from "./commands/redesignCommand.js";
import { registerHaltCommand } from "./commands/haltCommand.js";
import { registerExtendCommand } from "./commands/extendCommand.js";
import { registerPlannerTools } from "./tools/plannerTools.js";
import { registerOmbudsmanTools } from "./tools/ombudsmanTools.js";
import { setupVfsInterceptors } from "./vfs/lockManager.js";
import { setupOrchestrator, updateStatusWidget } from "./loops/orchestrator.js";
import { getState, resetState } from "./state.js";

export default function rigorousCoworkingExtension(pi: ExtensionAPI): void {
  // ── 1. VFS Split-Path Lock Protection ──
  // Intercepts mutation tool calls during design mode,
  // blocking writes to any path outside .agent/plans/
  setupVfsInterceptors(pi);

  // ── 2. Custom Tools ──
  // mutate_plan_graph: exclusive LLM interface for plan mutations
  // submit_gap_analysis: structured Ombudsman gap reporting (TypeBox schema)
  registerPlannerTools(pi);
  registerOmbudsmanTools(pi);

  // ── 3. User Commands ──
  registerTaskCommand(pi);
  registerGreenlightCommand(pi);
  registerStatusCommand(pi);
  registerResumeCommand(pi);
  registerModeCommand(pi);
  registerRedesignCommand(pi);
  registerHaltCommand(pi);
  registerExtendCommand(pi);

  // ── 4. Orchestrator State Machine ──
  // Central hub: reacts to agent_end to drive phase transitions
  // (ombudsman → modal → planning → execution → finished)
  setupOrchestrator(pi);

  // ── 5. Session Lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Rigorous Coworking Harness [Active] — Use /task to begin.",
        "info"
      );
      updateStatusWidget(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    resetState();
  });

  // ── 6. Tool result monitoring ──
  pi.on("tool_result", async (_event, ctx) => {
    const state = getState();
    if (state.activeTask && ctx.hasUI) {
      updateStatusWidget(ctx);
    }
  });

  // ── 7. Turn end → update widget ──
  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.hasUI) {
      updateStatusWidget(ctx);
    }
  });
}
