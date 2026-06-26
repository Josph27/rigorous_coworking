import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import { lockWorkspace, unlockWorkspace } from "../vfs/lockManager.js";
import { loadPlanGraph } from "../tools/plannerTools.js";
import {
  listActiveTasks,
  loadAssignment,
  formatPlanSummary,
} from "../ui/summaryRenderer.js";
import { buildOmbudsmanPrompt } from "../ombudsman/ombudsman.js";
import { updateStatusWidget } from "../loops/orchestrator.js";
import type { CoworkMode } from "../types/schema.js";

export function registerResumeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task-resume", {
    description: "Resume a task from .agent/plans/.",
    handler: async (_args, ctx) => {
      await handleResumeCommand(pi, ctx);
    },
  });
}

async function handleResumeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<void> {
  const tasks = await listActiveTasks(ctx.cwd);

  if (tasks.length === 0) {
    ctx.ui.notify("No tasks found under .agent/plans/.", "info");
    return;
  }

  const active = tasks.filter((t) => !t.finished);
  const completed = tasks.filter((t) => t.finished);

  const taskModes: Record<string, string> = {};
  for (const t of tasks) {
    const a = await loadAssignment(t.taskName, ctx.cwd);
    if (a) {
      const mm = a.match(/\*\*Mode:\*\*\s*(\d+)/);
      taskModes[t.taskName] = mm ? `M${mm[1]}` : "M?";
    } else {
      taskModes[t.taskName] = "M?";
    }
  }

  const toOption = (t: (typeof tasks)[0]) =>
    `[${taskModes[t.taskName]}] ${t.taskName}  ${t.status}  ${t.completedSteps}/${t.stepCount} steps`;

  const options: string[] = [];
  if (active.length > 0) {
    options.push("── Active ──");
    options.push(...active.map(toOption));
  }
  if (completed.length > 0) {
    options.push("── Completed ──");
    options.push(...completed.map(toOption));
  }
  options.push("Cancel");

  const choice = await ctx.ui.select("Resume task:", options);
  if (!choice || choice === "Cancel" || choice.startsWith("──")) return;

  const taskName = choice
    .split(/\s{2,}/)[0]
    .replace(/^\[M\d\]\s*/, "")
    .trim();
  const task = tasks.find((t) => t.taskName === taskName);
  if (!task) return;

  const state = getState();
  const plan = await loadPlanGraph(taskName, ctx.cwd);
  const assignment = await loadAssignment(taskName, ctx.cwd);

  let mode: CoworkMode = 1;
  if (assignment) {
    const mm = assignment.match(/\*\*Mode:\*\*\s*(\d+)/);
    if (mm) mode = parseInt(mm[1], 10) as CoworkMode;
  }

  state.activeTask = taskName;
  state.currentMode = mode;
  state.assignmentText = assignment || "";

  // ── No plan → restart Ombudsman ──
  if (!plan || plan.steps.length === 0) {
    lockWorkspace(taskName);
    state.phase = "ombudsman_analyzing";
    state.ombudsmanIterations = 0;
    state.gapRoundHistory = [];
    state._ombudsmanRound = 0;
    state._earlyGreenlight = false;

    ctx.ui.notify(`Resumed: "${taskName}" — Ombudsman`, "info");
    pi.sendMessage(
      {
        customType: "rigorous-assignment",
        content: `# Assignment: ${taskName}\n\n${state.assignmentText.slice(0, 2000)}`,
        display: true,
      },
      { triggerTurn: false }
    );
    pi.sendUserMessage(buildOmbudsmanPrompt(state.assignmentText, state.activeTask!), {
      deliverAs: "followUp",
      triggerTurn: true,
    });
    updateStatusWidget(ctx);
    return;
  }

  state.planGraph = plan;

  switch (plan.status) {
    case "designing":
    case "finished": {
      lockWorkspace(taskName);
      state.phase = "plan_review";

      ctx.ui.notify(`Resumed: "${taskName}" — Plan Review`, "info");
      pi.sendMessage(
        {
          customType: "rigorous-plan-summary",
          content: formatPlanSummary(plan, taskName),
          display: true,
        },
        { triggerTurn: false }
      );
      break;
    }

    case "executing": {
      unlockWorkspace();
      state.phase = "executing";

      const nextIdx = plan.steps.findIndex((s) => !s.is_completed);
      state.currentStepIndex = nextIdx >= 0 ? nextIdx : plan.steps.length;
      const completed = plan.steps.filter((s) => s.is_completed).length;

      if (state.currentStepIndex >= plan.steps.length) {
        plan.status = "finished";
        state.phase = "finished";
        ctx.ui.notify(
          `Resumed: "${taskName}" — all steps already complete.`,
          "info"
        );
        updateStatusWidget(ctx);
        return;
      }

      const nextStep = plan.steps[state.currentStepIndex];
      ctx.ui.notify(
        `Resumed: "${taskName}" — Step ${nextStep.step_id}/${plan.steps.length}`,
        "info"
      );
      pi.sendMessage(
        {
          customType: "rigorous-plan-summary",
          content: formatPlanSummary(plan, taskName),
          display: true,
        },
        { triggerTurn: false }
      );

      if (state.currentMode === 0 || state.currentMode === 1) {
        pi.sendUserMessage(
          `[SYSTEM: Resume — Mode 0/1 Stepwise]\n\n` +
            `TASK: ${taskName}\n` +
            `RESUMING Step ${nextStep.step_id}: ${nextStep.headline}\n\n` +
            `Instructions: ${nextStep.description}\n` +
            `Success: ${nextStep.success_criteria}\n\n` +
            `Execute ONLY this step, then STOP.`,
          { deliverAs: "followUp", triggerTurn: true }
        );
        state.waitingForGreenlight = true;
      } else {
        pi.sendUserMessage(
          `[SYSTEM: Resume — Continuous]\n\n` +
            `TASK: ${taskName}\n` +
            `Resume from step ${state.currentStepIndex + 1}. Complete all remaining steps.`,
          { deliverAs: "followUp", triggerTurn: true }
        );
      }
      break;
    }

    case "evaluating_exception": {
      lockWorkspace(taskName);
      state.phase = "evaluating_exception";

      ctx.ui.notify(
        `Resumed: "${taskName}" — Exception state. /greenlight to re-attempt.`,
        "warning"
      );
      pi.sendMessage(
        {
          customType: "rigorous-plan-summary",
          content: formatPlanSummary(plan, taskName),
          display: true,
        },
        { triggerTurn: false }
      );
      break;
    }

    default:
      ctx.ui.notify(`Unknown plan status: ${plan.status}`, "error");
      break;
  }

  updateStatusWidget(ctx);
}
