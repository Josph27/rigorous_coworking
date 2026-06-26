import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState, type TaskPhase } from "../state.js";
import { loadPlanGraph, savePlanGraph } from "../tools/plannerTools.js";
import { displayPlanSummary } from "../ui/summaryRenderer.js";
import {
  buildOmbudsmanPrompt,
  runOmbudsmanModal,
} from "../ombudsman/ombudsman.js";
import { unlockWorkspace, lockWorkspace } from "../vfs/lockManager.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Set up the orchestrator — the central state machine that drives
 * the rigorous coworking lifecycle.
 *
 * Phases:
 *   ombudsman_analyzing → ombudsman_modal (loop) → planning → plan_review → executing → finished
 *
 * All phase transitions are triggered by agent_end events, reacting
 * to the LLM's responses and user input from TUI modals.
 */
export function setupOrchestrator(pi: ExtensionAPI): void {
  // ── Detect plan.json creation/update by mutate_plan_graph ──
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "mutate_plan_graph") return;
    const state = getState();
    if (!state.activeTask) return;

    const plan = await loadPlanGraph(state.activeTask, ctx.cwd);
    if (plan) {
      state.planGraph = plan;
      // Show updated plan summary after every mutation (except mode 3 silent)
      if (ctx.hasUI && state.currentMode !== 3) {
        await displayPlanSummary(state.activeTask, ctx);
      }
    }
  });

  // ── Central state machine: agent_end ──
  pi.on("agent_end", async (event, ctx) => {
    const state = getState();
    if (!state.activeTask) return;

    switch (state.phase) {
      case "ombudsman_analyzing":
        await handleOmbudsmanResponse(pi, ctx);
        break;

      case "planning":
        await handlePlanningPhase(pi, ctx);
        break;

      case "executing":
        await handleExecutionPhase(pi, ctx, event.messages);
        break;

      case "evaluating_exception":
        // User must /greenlight or /task to proceed
        break;

      default:
        break;
    }
  });

  // ── Turn end: update status widget ──
  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.hasUI) {
      updateStatusWidget(ctx);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase handlers
// ═══════════════════════════════════════════════════════════════

/**
 * Ombudsman Analysis Phase:
 * Parse the LLM's gap analysis response. If gaps found, show the
 * TUI modal and loop. If clean, hand off to Plan Designer.
 */
async function handleOmbudsmanResponse(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  const state = getState();
  if (!state.activeTask) return;

  if (state._earlyGreenlight) {
    // User greenlit during ombudsman — skip to planning
    state._earlyGreenlight = false;
    state.phase = "planning";
    ctx.ui.notify("Early greenlight: proceeding to Plan Designer.", "info");
    triggerPlanDesigner(pi, ctx);
    return;
  }

  // Read the gap analysis from the submit_gap_analysis tool result.
  // The tool's execute handler stores it in state._pendingGapAnalysis
  // so we don't need to parse raw JSON from the LLM's text response.
  const analysis = state._pendingGapAnalysis;
  state._pendingGapAnalysis = null;

  if (!analysis) {
    // LLM did not call submit_gap_analysis — retry with a stern reminder
    // Track consecutive failures to prevent infinite loop
    state.ombudsmanIterations++;
    if (state.ombudsmanIterations > 5) {
      ctx.ui.notify(
        "Ombudsman: LLM failed to call submit_gap_analysis after 5 attempts. Proceeding with available information.",
        "warning"
      );
      state.phase = "planning";
      state.ombudsmanIterations = 0;
      triggerPlanDesigner(pi, ctx);
      return;
    }

    ctx.ui.notify(
      `Ombudsman: LLM did not call submit_gap_analysis (attempt ${state.ombudsmanIterations}/5). Retrying...`,
      "warning"
    );
    pi.sendUserMessage(
      `[SYSTEM: Ombudsman — RETRY]\n\n` +
        `You MUST call submit_gap_analysis. No raw text.\n\n` +
        buildOmbudsmanPrompt(state.assignmentText, state.activeTask!, state.gapRoundHistory),
      { deliverAs: "followUp", triggerTurn: true }
    );
    return;
  }

  // Successful tool call — reset retry counter, increment analysis round
  const analysisRound = state._ombudsmanRound + 1;
  state._ombudsmanRound = analysisRound;
  state.ombudsmanIterations = 0;

  if (analysis.is_complete || analysis.gaps.length === 0) {
    // ── Assignment verified complete → Handoff to Plan Designer ──
    ctx.ui.notify(
      `✓ Ombudsman: Assignment verified complete after ${analysisRound} round(s).`,
      "success"
    );
    state.phase = "planning";
    state.gapRoundHistory = [];
    state._ombudsmanRound = 0;

    // Emit event for other extensions to react to
    pi.events.emit("ombudsman_complete", {
      task: state.activeTask,
      mode: state.currentMode,
      rounds: analysisRound,
    });

    // Trigger Plan Designer
    triggerPlanDesigner(pi, ctx);
    return;
  }

  // ── Gaps found → Show TUI modal ──
  if (ctx.hasUI) {
    // If this is round 2+, show a pre-editor confirm dialog first
    if (analysisRound > 1) {
      const remainingSummary = summarizeRemainingGaps(analysis.gaps);
      const choice = await ctx.ui.select(
        `Ombudsman round ${analysisRound}: ${analysis.gaps.length} gap(s) remaining`,
        [
          "Continue — address remaining gaps",
          `Greenlight — skip to planning (${analysis.gaps.length} gap(s) left to agent)`,
        ]
      );

      if (!choice || choice.startsWith("Greenlight")) {
        state.phase = "planning";
        state.gapRoundHistory = [];
        state._ombudsmanRound = 0;
        ctx.ui.notify(
          `Early greenlight. ${analysis.gaps.length} gap(s) left to agent discretion.`,
          "info"
        );
        triggerPlanDesigner(pi, ctx);
        return;
      }

      // Show what's still missing
      if (remainingSummary) {
        ctx.ui.notify(`Still needs: ${remainingSummary}`, "info");
      }
    }

    state.phase = "ombudsman_modal";

    const { assignment: updatedAssignment, answers } = await runOmbudsmanModal(
      analysis.gaps,
      state.activeTask,
      state.assignmentText,
      ctx
    );

    // Accumulate gap round history (description + user answer pairs)
    for (let i = 0; i < analysis.gaps.length; i++) {
      const answer = answers[i] || "";
      if (answer) {
        state.gapRoundHistory = state.gapRoundHistory.filter(
          (h) => h.description !== analysis.gaps[i].description
        );
        state.gapRoundHistory.push({
          description: analysis.gaps[i].description,
          answer,
        });
      } else {
        if (!state.gapRoundHistory.some((h) => h.description === analysis.gaps[i].description)) {
          state.gapRoundHistory.push({
            description: analysis.gaps[i].description,
            answer: "(left to agent discretion)",
          });
        }
      }
    }

    // Save updated assignment
    state.assignmentText = updatedAssignment;
    const plansDir = path.join(ctx.cwd, ".agent", "plans", state.activeTask);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(
      path.join(plansDir, "assignment.md"),
      updatedAssignment,
      "utf-8"
    );

    // Always re-send to LLM for re-analysis (confirm moved to next round's entry)
    state.phase = "ombudsman_analyzing";
    pi.sendUserMessage(
      buildOmbudsmanPrompt(updatedAssignment, state.activeTask!, state.gapRoundHistory),
      { deliverAs: "followUp", triggerTurn: true }
    );
  } else {
    // Non-interactive mode: can't show modal, proceed with gaps
    ctx.ui.notify(
      `Ombudsman: ${analysis.gaps.length} gap(s) found but UI unavailable. Proceeding anyway.`,
      "warning"
    );
    state.phase = "planning";
    triggerPlanDesigner(pi, ctx);
  }
}

/**
 * Planning Phase:
 * Check if the Plan Designer has created plan.json via mutate_plan_graph.
 * If yes → render summary → enter plan_review (or auto-greenlight for mode 3).
 */
async function handlePlanningPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  const state = getState();
  if (!state.activeTask || state.phase !== "planning") return;

  const plan = state.planGraph;
  if (!plan || plan.steps.length === 0) {
    // Plan hasn't been created yet — prompt the LLM again
    pi.sendUserMessage(
      `[SYSTEM: Plan Designer — ACTION REQUIRED]\n\n` +
        `You must use the \`mutate_plan_graph\` tool to create an execution plan ` +
        `for task "${state.activeTask}". Direct file writes are blocked by VFS lock.\n\n` +
        `Call mutate_plan_graph now with the complete plan.`,
      { deliverAs: "followUp", triggerTurn: true }
    );
    return;
  }

  // Plan is ready
  ctx.ui.notify(
    `Plan created: ${plan.steps.length} step(s) for "${state.activeTask}".`,
    "success"
  );

  // Display programmatic summary
  if (ctx.hasUI) {
    await displayPlanSummary(state.activeTask, ctx);
  }

  // Mode-dependent next action
  if (state.currentMode === 3) {
    // Mode 3: auto-greenlight with cost gate
    await handleMode3AutoGreenlight(pi, ctx, plan);
  } else {
    // Mode 1/2: wait for user review or /greenlight
    state.phase = "plan_review";
    ctx.ui.notify(
      `Review the plan above. Use /greenlight to proceed, ` +
        `or chat to provide refinement feedback.`,
      "info"
    );
  }
}

/**
 * Execution Phase:
 * Track step completion, handle mode-specific behavior.
 */
async function handleExecutionPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: readonly unknown[]
): Promise<void> {
  const state = getState();
  if (!state.activeTask || state.phase !== "executing") return;

  const plan = await loadPlanGraph(state.activeTask, ctx.cwd);
  if (!plan) return;

  // Detect step completions from assistant response
  const responseText = extractLastAssistantText(messages);
  if (responseText) {
    detectStepCompletions(responseText, plan);
    await savePlanGraph(state.activeTask, plan, ctx.cwd);
    state.planGraph = plan;
  }

  const completed = plan.steps.filter((s) => s.is_completed).length;
  const total = plan.steps.length;

  // ── All steps done ──
  if (plan.steps.every((s) => s.is_completed)) {
    plan.status = "finished";
    await savePlanGraph(state.activeTask, plan, ctx.cwd);
    state.planGraph = plan;
    state.phase = "finished";
    state.isFinishingGraph = true;

    if (ctx.hasUI) {
      ctx.ui.notify(
        `✓ Task "${state.activeTask}" complete! ${completed}/${total} steps verified.`,
        "success"
      );
      await displayPlanSummary(state.activeTask, ctx);
    }

    logCompletionStats(state.activeTask, plan);
    state.isFinishingGraph = false;
    return;
  }

  // ── Per-mode execution behavior ──
  const currentStep = plan.steps[state.currentStepIndex];
  const stepFailed = responseText ? detectExceptionInResponse(responseText) : false;
  const atStopPoint = currentStep
    ? state.stopPoints.includes(currentStep.step_id)
    : false;

  switch (state.currentMode) {
    case 0: {
      // Mode 0: stepwise — halt after EVERY step
      if (!state.waitingForGreenlight) break;

      if (stepFailed) {
        handleStepFailure(pi, ctx, state.activeTask, currentStep);
        return;
      }

      markStepComplete(plan, state);
      await savePlanGraph(state.activeTask, plan, ctx.cwd);
      state.planGraph = plan;

      if (ctx.hasUI) {
        const next = plan.steps[state.currentStepIndex + 1];
        ctx.ui.notify(
          `Step ${currentStep?.step_id ?? "?"} complete. ` +
            `Next: Step ${next?.step_id ?? "N/A"}: ${next?.headline ?? "Finished"}\n` +
            `Use /greenlight to proceed.`,
          "info"
        );
      }
      break;
    }

    case 1: {
      // Mode 1: semi-auto — auto-proceed on success, halt on failure or stop point
      if (!state.waitingForGreenlight) break;

      if (stepFailed) {
        handleStepFailure(pi, ctx, state.activeTask, currentStep);
        return;
      }

      markStepComplete(plan, state);
      await savePlanGraph(state.activeTask, plan, ctx.cwd);
      state.planGraph = plan;

      // Check if we should halt at this step (stop point)
      if (atStopPoint) {
        state.waitingForGreenlight = true; // keep waiting
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Stop point at Step ${currentStep?.step_id ?? "?"}. Review progress, then /greenlight.`,
            "info"
          );
        }
      } else {
        // Auto-advance to next step
        state.waitingForGreenlight = false;
        state.currentStepIndex++;
        const next = plan.steps[state.currentStepIndex];
        if (next) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `✓ Step ${currentStep?.step_id ?? "?"} done. Auto-advancing to Step ${next.step_id}.`,
              "success"
            );
          }
          pi.sendUserMessage(
            `[SYSTEM: Auto-advance — Mode 1]\n\n` +
              `Step ${currentStep?.step_id ?? "?"} completed successfully.\n` +
              `Now execute Step ${next.step_id}: ${next.headline}\n\n` +
              `Instructions: ${next.description}\n` +
              `Success: ${next.success_criteria}`,
            { deliverAs: "followUp", triggerTurn: true }
          );
          state.waitingForGreenlight = true;
        }
      }
      break;
    }

    case 2: {
      // Mode 2: continuous — halt on exception alarm or stop point
      if (!state.waitingForGreenlight) break;

      if (stepFailed) {
        await handleMode2Exception(pi, ctx, state.activeTask, plan, responseText);
        return;
      }

      markStepComplete(plan, state);
      await savePlanGraph(state.activeTask, plan, ctx.cwd);
      state.planGraph = plan;

      if (atStopPoint) {
        state.waitingForGreenlight = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Stop point at Step ${currentStep?.step_id ?? "?"}. Review progress, then /greenlight.`,
            "info"
          );
        }
      }
      // In mode 2, steps auto-advance via the original continuous prompt
      break;
    }

    case 3: {
      // Mode 3: silent — only halt on cost gate, ignore stop points
      if (!state.waitingForGreenlight) break;

      if (stepFailed) {
        await handleMode2Exception(pi, ctx, state.activeTask, plan, responseText);
        return;
      }

      markStepComplete(plan, state);
      await savePlanGraph(state.activeTask, plan, ctx.cwd);
      state.planGraph = plan;
      break;
    }

    default:
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Trigger the Plan Designer agent by sending a hidden prompt.
 */
function triggerPlanDesigner(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = getState();
  if (!state.activeTask) return;

  ctx.ui.notify("Yielding to Plan Designer Agent...", "info");

  const allTools = pi.getAllTools();
  const toolDefinitions = allTools
    .filter((t) => t.name !== "mutate_plan_graph" && t.name !== "submit_gap_analysis")
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join("\n");

  // Load existing plan for extend mode
  const existingPlan = state.planGraph;
  const isExtend = state._extendMode;
  state._extendMode = false;

  let extendBlock = "";
  if (isExtend && existingPlan) {
    const completed = existingPlan.steps.filter((s) => s.is_completed);
    const nextId = existingPlan.steps.length + 1;
    extendBlock =
      `\nEXISTING PLAN (EXTEND MODE):\n` +
      `This task already has ${existingPlan.steps.length} step(s). ` +
      `${completed.length} are completed and LOCKED.\n\n` +
      existingPlan.steps
        .map(
          (s) =>
            `  Step ${s.step_id}: ${s.headline} ${s.is_completed ? "[✓ LOCKED]" : "[ ]"}`
        )
        .join("\n") +
      `\n\nCRITICAL: You are EXTENDING this plan. Keep ALL existing steps exactly as-is. ` +
      `Add NEW steps starting at step_id ${nextId}. Do NOT modify or reorder existing steps.\n`;
  }

  pi.sendUserMessage(
    `[SYSTEM: Plan Designer Agent]\n\n` +
      `You are the Plan Designer Agent. Create a rigorous execution plan for this task.\n\n` +
      `TASK NAME: ${state.activeTask}\n\n` +
      `AVAILABLE TOOLS (route steps to appropriate tools):\n${toolDefinitions}\n\n` +
      `ASSIGNMENT:\n${state.assignmentText}\n\n` +
      `${extendBlock}` +
      `INSTRUCTIONS:\n` +
      `1. Analyze the assignment thoroughly.\n` +
      `2. Use the \`mutate_plan_graph\` tool to create the execution plan.\n` +
      `3. Each step must have:\n` +
      `   - step_id: unique sequential number starting at 1\n` +
      `   - headline: concise summary\n` +
      `   - description: detailed implementation instructions\n` +
      `   - model_target: "default" (for the currently active model)\n` +
      `   - success_criteria: a measurable, verifiable completion test\n` +
      `4. Set task_id to "${state.activeTask}" and status to "designing".\n` +
      `5. After calling the tool, respond with a brief confirmation.\n\n` +
      `IMPORTANT: You MUST call mutate_plan_graph. Direct file writes are blocked by VFS lock.`,
    { deliverAs: "followUp", triggerTurn: true }
  );
}

/**
 * Mode 3: auto-greenlight with upfront cost gating.
 */
async function handleMode3AutoGreenlight(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  plan: { steps: Array<unknown>; status: string }
): Promise<void> {
  const state = getState();

  // Cost gate: >20 steps requires user review even in mode 3
  if (plan.steps.length > 20) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `⚠ Cost Gate: Plan has ${plan.steps.length} steps (>20). ` +
          `Mode 3 requires user review for large plans. Use /greenlight to proceed.`,
        "error"
      );
    }
    state.currentMode = 2;
    state.phase = "plan_review";
    return;
  }

  // Cost nominal → auto-greenlight
  unlockWorkspace();
  plan.status = "executing";
  state.planGraph = plan as typeof state.planGraph;
  state.phase = "executing";

  ctx.ui.notify(
    "Mode 3: Auto-greenlight applied. Executing silently...",
    "info"
  );

  pi.sendUserMessage(
    `[SYSTEM: Orchestrator — Mode 3 Silent Execution]\n\n` +
      `Execute all steps in the plan for task "${state.activeTask}" silently.\n` +
      `Complete each step without asking for confirmation.\n` +
      `Report final completion status only when all steps are done.\n\n` +
      `Plan:\n` +
      (plan.steps as Array<{ step_id: number; headline: string }>)
        .map((s) => `  Step ${s.step_id}: ${s.headline}`)
        .join("\n"),
    { deliverAs: "followUp", triggerTurn: true }
  );
}

/**
 * Mark the current step as complete.
 */
function markStepComplete(
  plan: { steps: Array<{ step_id: number; is_completed: boolean }> },
  state: ReturnType<typeof getState>
): void {
  const step = plan.steps[state.currentStepIndex];
  if (step && !step.is_completed) {
    step.is_completed = true;
  }
}

/**
 * Handle step failure: lock VFS, enter exception state, prompt agent to revise.
 */
function handleStepFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  taskName: string,
  step: { step_id: number; headline: string } | undefined
): void {
  const state = getState();
  lockWorkspace(taskName);
  state.phase = "evaluating_exception";
  state.waitingForGreenlight = false;

  if (ctx.hasUI) {
    ctx.ui.notify(
      `⚠ Step ${step?.step_id ?? "?"} failed. VFS re-locked. Use /greenlight to re-attempt.`,
      "error"
    );
  }

  pi.sendUserMessage(
    `[SYSTEM: Step Failure — Plan Revision Required]\n\n` +
      `Step ${step?.step_id ?? "?"} ("${step?.headline ?? ""}") failed.\n\n` +
      `Revise the plan via mutate_plan_graph, then await /greenlight.`,
    { deliverAs: "followUp", triggerTurn: true }
  );
}

/**
 * Extract text from the last assistant message in the message list.
 */
function extractLastAssistantText(
  messages: readonly unknown[]
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: string;
      content?: unknown;
      message?: { role?: string; content?: unknown };
    };

    // Direct message format
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
      }
    }

    // Nested AgentMessage format
    if (msg.message && (msg as { type: string }).type === "message") {
      const inner = msg.message;
      if (inner.role === "assistant") {
        if (typeof inner.content === "string") return inner.content;
        if (Array.isArray(inner.content)) {
          return inner.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("\n");
        }
      }
    }
  }
  return null;
}

/**
 * Detect step completions from message text.
 * Matches patterns like "Step X complete/done/finished", "[DONE:X]", "✓ Step X".
 */
function detectStepCompletions(
  text: string,
  plan: { steps: Array<{ step_id: number; is_completed: boolean }> }
): number {
  let completed = 0;

  for (const step of plan.steps) {
    if (step.is_completed) continue;

    const patterns = [
      new RegExp(
        `Step\\s*${step.step_id}[\\s:].*?(?:done|complete|finished|success|passed|verified)`,
        "i"
      ),
      new RegExp(`\\[DONE:${step.step_id}\\]`, "i"),
      new RegExp(`✓\\s*Step\\s*${step.step_id}`, "i"),
    ];

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        step.is_completed = true;
        completed++;
        break;
      }
    }
  }

  return completed;
}

/**
 * Detect exception indicators in assistant response for mode 2 complexity alarm.
 */
function detectExceptionInResponse(text: string): boolean {
  const exceptionIndicators = [
    /\b(?:error|exception|fail|cannot|unable|impossible)\b/i,
    /\b(?:blocked|refused|denied|timeout|exceeded)\b/i,
    /\b(?:need to restructure|significant changes? required|plan revision needed)\b/i,
  ];

  return exceptionIndicators.some((p) => p.test(text));
}

/**
 * Mode 2 complexity alarm: if an exception requires >3 new sub-steps, halt.
 */
async function handleMode2Exception(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  taskName: string,
  plan: { steps: Array<{ step_id: number }>; status: string },
  assistantText: string
): Promise<void> {
  const state = getState();
  const proposedSteps =
    (assistantText.match(
      /\b(?:new step|sub-step|additional step)\b/gi
    ) || []).length;

  if (proposedSteps > 3) {
    plan.status = "evaluating_exception";
    state.phase = "evaluating_exception";

    // Re-lock VFS to prevent uncontrolled writes during exception resolution
    lockWorkspace(taskName);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `⚠ Complexity Threshold Exceeded!\n` +
          `Task "${taskName}" requires >3 additional sub-steps.\n` +
          `VFS re-locked. Autonomous healing halted. Review and use /greenlight to proceed.`,
        "error"
      );
      await displayPlanSummary(taskName, ctx);
    }
  }
}

/**
 * Log completion statistics.
 */
function logCompletionStats(
  taskName: string,
  plan: { steps: Array<{ step_id: number; is_completed: boolean }> }
): void {
  const completed = plan.steps.filter((s) => s.is_completed).length;
  const total = plan.steps.length;
  console.error(
    `[rigor] Task "${taskName}" complete: ${completed}/${total} steps verified.`
  );
}

/**
 * Summarize remaining gaps into broad category hints for the early-greenlight prompt.
 * Groups gaps into: success condition, design, architecture, tooling.
 * Returns a short string like "success criteria, design" or empty if none.
 */
function summarizeRemainingGaps(
  gaps: Array<{ category: string; description: string }>
): string {
  const hints: string[] = [];

  const hasCategory = (cat: string) => gaps.some((g) => g.category === cat);

  if (hasCategory("unverified_completeness")) hints.push("success criteria");
  if (hasCategory("ambiguous_outcome")) hints.push("design decisions");
  if (hasCategory("missing_steps")) hints.push("architecture / steps");
  if (hasCategory("missing_context")) hints.push("tooling / dependencies");
  if (hasCategory("scope_too_broad")) hints.push("scope boundary");

  // Fallback: use raw categories
  if (hints.length === 0 && gaps.length > 0) {
    return gaps.map((g) => g.category).join(", ");
  }

  return hints.join(", ");
}

/**
 * Update the TUI status widget.
 */
export function updateStatusWidget(ctx: {
  ui: {
    setStatus: (id: string, text: string | undefined) => void;
    setWidget: (id: string, lines: string[], opts?: { placement?: string }) => void;
  };
  hasUI: boolean;
}): void {
  if (!ctx.hasUI) return;
  const state = getState();

  if (!state.activeTask) {
    ctx.ui.setStatus("rigorous-coworking", undefined);
    ctx.ui.setWidget("rigorous-task-banner", undefined);
    return;
  }

  // Footer status
  const phaseLabels: Record<TaskPhase, string> = {
    idle: "○ Idle",
    ombudsman_analyzing: "🔍 Ombudsman: analyzing...",
    ombudsman_modal: "❓ Ombudsman: clarifying...",
    planning: "📋 Planning...",
    plan_review: "📋 Review plan (/greenlight)",
    executing: state.waitingForGreenlight
      ? `⏸ Step ${state.currentStepIndex + 1}/${state.planGraph?.steps.length ?? "?"}`
      : `▶ Exec: ${state.planGraph?.steps.filter((s) => s.is_completed).length ?? 0}/${state.planGraph?.steps.length ?? "?"}`,
    evaluating_exception: "⚠ Exception: /greenlight",
    finished: "✓ Done",
  };

  const label = phaseLabels[state.phase] ?? state.phase;
  ctx.ui.setStatus("rigorous-coworking", `${label} — ${state.activeTask}`);

  // Widget above editor: task mode indicator with spinner
  const busyPhases: TaskPhase[] = [
    "ombudsman_analyzing",
    "planning",
    "executing",
  ];
  const isBusy = busyPhases.includes(state.phase);

  // Simple rotating spinner frame
  const spinnerFrames = ["◌", "◍", "●", "◍"];
  const icon = isBusy
    ? spinnerFrames[state._spinnerFrame % spinnerFrames.length]
    : "⏸";
  if (isBusy) state._spinnerFrame++;
  const modeLabel = state.currentMode !== null ? `M${state.currentMode}` : "M?";

  ctx.ui.setWidget(
    "rigorous-task-banner",
    [`${icon} (task: ${modeLabel} — ${state.activeTask})`],
    { placement: "aboveEditor" }
  );
}
