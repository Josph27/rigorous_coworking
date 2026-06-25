import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanGraph } from "../types/schema.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Programmatically render the plan summary without any LLM overhead.
 * Parses plan.json directly and outputs step headlines + approach bullets + tools.
 */
export async function renderPlanSummary(
  taskName: string,
  ctx: ExtensionContext
): Promise<string> {
  const planPath = path.join(ctx.cwd, ".agent", "plans", taskName, "plan.json");
  let plan: PlanGraph;
  try {
    const raw = await fs.readFile(planPath, "utf-8");
    plan = JSON.parse(raw) as PlanGraph;
  } catch {
    return `No plan found for task "${taskName}".`;
  }
  return formatPlanSummary(plan, taskName);
}

/**
 * Format a PlanGraph into a readable summary with approach bullets and tool hints.
 */
export function formatPlanSummary(plan: PlanGraph, taskName: string): string {
  const statusIcon =
    plan.status === "finished" ? "✓"
    : plan.status === "executing" ? "▶"
    : plan.status === "evaluating_exception" ? "⚠"
    : "○";

  const completed = plan.steps.filter((s) => s.is_completed).length;

  let summary = `\n══ Plan: ${taskName} ══ ${statusIcon} ${plan.status} ══ ${completed}/${plan.steps.length} steps\n\n`;

  for (const step of plan.steps) {
    const status = step.is_completed ? "[✓]" : "[ ]";
    const model = step.model_target === "default" ? "" : `  [model: ${step.model_target}]`;
    summary += `${status} Step ${step.step_id}: ${step.headline}${model}\n`;

    // Truncated approach bullets from description
    const bullets = extractApproachBullets(step.description);
    for (const b of bullets) {
      summary += `     • ${b}\n`;
    }
    summary += `     verify: ${truncate(step.success_criteria, 80)}\n\n`;
  }

  summary += `══════════════════════════════════════\n`;
  return summary;
}

/**
 * Extract approach steps from the description text.
 * Splits on newlines, numbered items, or sentence boundaries.
 * Returns up to 3 short bullet strings.
 */
function extractApproachBullets(description: string): string[] {
  const raw = description.replace(/\n{2,}/g, "\n").trim();

  // Check for explicit numbered/bulleted list
  const lines = raw.split("\n").map((l) => l.replace(/^[\d]+[.)]\s*/, "").replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

  if (lines.length >= 2) {
    return lines.slice(0, 3).map((l) => truncate(l, 80));
  }

  // Single paragraph — split on sentences
  const sentences = raw.split(/(?<=[.!?])\s+/);
  return sentences.slice(0, 3).map((s) => truncate(s.trim(), 80)).filter(Boolean);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/**
 * Render the summary to the TUI.
 */
export async function displayPlanSummary(
  taskName: string,
  ctx: ExtensionContext
): Promise<void> {
  const summary = await renderPlanSummary(taskName, ctx);
  if (ctx.hasUI) {
    ctx.ui.notify(summary, "info");
  }
}

/**
 * List all non-finished tasks under .agent/plans/.
 * Returns { taskName, status, stepCount, completedSteps } for each.
 */
export async function listActiveTasks(cwd: string): Promise<
  Array<{ taskName: string; status: string; stepCount: number; completedSteps: number; finished: boolean }>
> {
  const plansDir = path.join(cwd, ".agent", "plans");
  const results: Array<{ taskName: string; status: string; stepCount: number; completedSteps: number; finished: boolean }> = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(plansDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const planPath = path.join(plansDir, entry.name, "plan.json");
    try {
      const raw = await fs.readFile(planPath, "utf-8");
      const plan = JSON.parse(raw) as PlanGraph;
      results.push({
        taskName: entry.name,
        status: plan.status,
        stepCount: plan.steps.length,
        completedSteps: plan.steps.filter((s) => s.is_completed).length,
        finished: plan.status === "finished",
      });
    } catch {
      // No plan.json yet — task might be in ombudsman phase
      const assignmentPath = path.join(plansDir, entry.name, "assignment.md");
      try {
        await fs.access(assignmentPath);
        results.push({
          taskName: entry.name,
          status: "ombudsman/planning",
          stepCount: 0,
          completedSteps: 0,
          finished: false,
        });
      } catch {
        // No assignment either — skip
      }
    }
  }

  // Sort: active first, finished last
  results.sort((a, b) => (a.finished === b.finished ? 0 : a.finished ? 1 : -1));
  return results;
}

/**
 * Load the assignment text for a task.
 */
export async function loadAssignment(
  taskName: string,
  cwd: string
): Promise<string | null> {
  const p = path.join(cwd, ".agent", "plans", taskName, "assignment.md");
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}
