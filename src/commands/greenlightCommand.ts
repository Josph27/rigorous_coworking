import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getState, resolveGreenlight } from "../state.js";
import { unlockWorkspace } from "../vfs/lockManager.js";
import { loadPlanGraph, savePlanGraph } from "../tools/plannerTools.js";
import { formatPlanSummary } from "../ui/summaryRenderer.js";

/**
 * Register the /greenlight command.
 *
 * Actions depend on current phase:
 *   plan_review           → unlock VFS, mark plan executing, start execution
 *   executing (mode 1)    → advance to next step
 *   evaluating_exception  → acknowledge alarm, resume
 *   ombudsman_* / planning → n/a (wait for state machine)
 */
export function registerGreenlightCommand(pi: ExtensionAPI): void {
  pi.registerCommand("greenlight", {
    description:
      "Approve the current plan and begin execution, or advance to the next step.",
    handler: async (_args, ctx) => {
      await handleGreenlightCommand(pi, ctx);
    },
  });
}

async function handleGreenlightCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = getState();

  if (!state.activeTask) {
    ctx.ui.notify("No active task. Use /task first.", "warning");
    return;
  }

  const taskName = state.activeTask;
  const plan = await loadPlanGraph(taskName, ctx.cwd);

  switch (state.phase) {
    // ── Plan review → Begin execution ──
    case "plan_review": {
      unlockWorkspace();

      if (plan) {
        plan.status = "executing";
        state.planGraph = plan;
        await savePlanGraph(taskName, plan, ctx.cwd);
      }

      state.phase = "executing";
      ctx.ui.notify(
        `Greenlight: VFS unlocked. Execution authorized for "${taskName}".`,
        "success"
      );
      resolveGreenlight();

      // Trigger execution based on mode
      await triggerExecution(pi, ctx, taskName, plan);
      break;
    }

    // ── Mode 0/1 stepwise: advance to next step ──
    case "executing": {
      if (!state.waitingForGreenlight) {
        ctx.ui.notify(
          "No step pending. Execution is running continuously or already finished.",
          "info"
        );
        return;
      }

      state.waitingForGreenlight = false;
      state.currentStepIndex++;
      resolveGreenlight();

      await triggerNextStep(pi, ctx, taskName, plan);
      break;
    }

    // ── Exception acknowledged ──
    case "evaluating_exception": {
      unlockWorkspace();

      if (plan) {
        plan.status = "executing";
        state.planGraph = plan;
        await savePlanGraph(taskName, plan, ctx.cwd);
      }
      state.phase = "executing";

      ctx.ui.notify(
        "Greenlight: Exception acknowledged. Resuming execution.",
        "info"
      );
      resolveGreenlight();

      // Mode 0: re-attempt the failed step (stepwise, don't advance index)
      // Mode 1/2: re-attempt or resume
      if (state.currentMode === 0) {
        await triggerNextStep(pi, ctx, taskName, plan);
      } else if (state.currentMode === 1) {
        await triggerNextStep(pi, ctx, taskName, plan);
      } else {
        await triggerContinuousExecution(pi, ctx, taskName, plan);
      }
      break;
    }

    // ── Ombudsman phases: early greenlight → skip to planning ──
    case "ombudsman_analyzing":
    case "ombudsman_modal": {
      // Mark all current gaps as "left to agent discretion"
      // The orchestrator's agent_end handler checks _earlyGreenlight and
      // skips directly to planning on the next turn boundary.
      state._earlyGreenlight = true;
      state.gapRoundHistory = [];
      state._ombudsmanRound = 0;

      ctx.ui.notify(
        "Greenlight: Ombudsman skipped. Unresolved gaps left to agent discretion. Proceeding to Plan Designer on next turn boundary.",
        "info"
      );
      break;
    }

    // ── Idle or finished ──
    case "idle":
    case "finished": {
      ctx.ui.notify(
        "No pending action requires greenlight. Use /task to start a new task.",
        "info"
      );
      break;
    }

    default:
      break;
  }
}

/**
 * Trigger initial execution — mode-dependent.
 */
async function triggerExecution(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  taskName: string,
  plan: Awaited<ReturnType<typeof loadPlanGraph>>
): Promise<void> {
  const state = getState();

  if (!plan || plan.steps.length === 0) {
    ctx.ui.notify("No execution steps in plan.", "error");
    return;
  }

  const summary = formatPlanSummary(plan, taskName);
  ctx.ui.notify(summary, "info");

  if (state.currentMode === 0 || state.currentMode === 1) {
    state.currentStepIndex = 0;
    state.waitingForGreenlight = false;
    await triggerNextStep(pi, ctx, taskName, plan);
  } else if (state.currentMode === 2) {
    await triggerContinuousExecution(pi, ctx, taskName, plan);
  }
}

/**
 * Trigger execution of the current step (mode 1 stepwise).
 */
async function triggerNextStep(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  taskName: string,
  plan: Awaited<ReturnType<typeof loadPlanGraph>>
): Promise<void> {
  const state = getState();

  if (!plan || state.currentStepIndex >= plan.steps.length) {
    plan!.status = "finished";
    state.planGraph = plan;
    state.phase = "finished";
    await savePlanGraph(taskName, plan!, ctx.cwd);

    ctx.ui.notify(
      `✓ All ${plan!.steps.length} steps completed. Task finished.`,
      "success"
    );
    return;
  }

  const step = plan.steps[state.currentStepIndex];
  ctx.ui.notify(
    `▶ Step ${step.step_id}/${plan.steps.length}: ${step.headline}`,
    "info"
  );

  pi.sendUserMessage(
    `[SYSTEM: Orchestrator — Mode 1 Stepwise]\n\n` +
      `TASK: ${taskName}\n` +
      `EXECUTING STEP ${step.step_id}: ${step.headline}\n\n` +
      `DETAILED INSTRUCTIONS:\n${step.description}\n\n` +
      `SUCCESS CRITERIA:\n${step.success_criteria}\n\n` +
      `Execute ONLY this step. After completing, verify the success criteria ` +
      `and STOP. Do not proceed to the next step. Report outcome.`,
    { deliverAs: "followUp", triggerTurn: true }
  );

  state.waitingForGreenlight = true;
}

/**
 * Trigger continuous execution (mode 2).
 */
async function triggerContinuousExecution(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  taskName: string,
  plan: Awaited<ReturnType<typeof loadPlanGraph>>
): Promise<void> {
  if (!plan) return;

  ctx.ui.notify(
    `▶ Mode 2: Continuous execution of ${plan.steps.length} steps.`,
    "info"
  );

  pi.sendUserMessage(
    `[SYSTEM: Orchestrator — Mode 2 Continuous]\n\n` +
      `TASK: ${taskName}\n\n` +
      `Execute all steps in order. For each step, follow the instructions and ` +
      `verify success criteria. If a step fails, attempt local self-healing. ` +
      `If the fix requires >3 new sub-steps, stop and report.\n\n` +
      plan.steps
        .map(
          (s) =>
            `--- Step ${s.step_id}: ${s.headline} ---\n${s.description}\nSuccess: ${s.success_criteria}\n`
        )
        .join("\n"),
    { deliverAs: "followUp", triggerTurn: true }
  );
}
