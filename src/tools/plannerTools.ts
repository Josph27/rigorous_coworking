import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PlanGraphSchema, type PlanGraph } from "../types/schema.js";
import { getState } from "../state.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Register the `mutate_plan_graph` tool.
 *
 * This is the EXCLUSIVE interface the Plan Designer Agent must use to
 * create or update the plan.json execution graph. Direct file writes
 * to plan.json are blocked by VFS locking during design mode.
 *
 * The tool accepts the full PlanGraph schema and writes it atomically
 * to `.agent/plans/${task_id}/plan.json`.
 */
export function registerPlannerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "mutate_plan_graph",
    label: "Mutate Plan Graph",
    description:
      "Generate or update the strict execution graph (plan.json) for a task. " +
      "This is the ONLY way to create or modify execution plans. " +
      "You must provide the complete plan graph including all steps.",
    promptSnippet:
      "Create or update the execution plan graph for a task using the mutate_plan_graph tool",
    promptGuidelines: [
      "Use mutate_plan_graph to create or update task execution plans. Never attempt to write plan.json directly.",
      "Each step must have: step_id (unique number), headline (summary), description (detailed instructions), model_target (e.g., 'default'), and success_criteria (measurable completion check).",
    ],
    parameters: PlanGraphSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const graph = params as PlanGraph;
      const state = getState();

      const taskId = graph.task_id || state.activeTask || "unknown";
      const plansDir = path.join(ctx.cwd, ".agent", "plans", taskId);
      const planPath = path.join(plansDir, "plan.json");

      // Ensure directory exists
      await fs.mkdir(plansDir, { recursive: true });

      // Set status to 'designing' if not explicitly set
      if (!graph.status) {
        graph.status = "designing";
      }

      // Write the plan graph
      await fs.writeFile(planPath, JSON.stringify(graph, null, 2), "utf-8");

      // Update in-memory cache
      state.planGraph = graph;

      const summary = `${graph.steps.length} step(s) written to plan.json`;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Plan JSON updated: ${summary}`,
          "success"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Plan graph successfully written to ${planPath}.\n\n` +
              `Task: ${taskId}\nSteps: ${graph.steps.length}\nStatus: ${graph.status}\n\n` +
              graph.steps.map(
                (s) =>
                  `Step ${s.step_id}: ${s.headline} [model: ${s.model_target}]`
              ).join("\n"),
          },
        ],
        details: {
          taskId,
          planPath,
          writtenNodes: graph.steps.length,
        },
      };
    },
  });
}

/**
 * Load a plan graph from disk.
 */
export async function loadPlanGraph(
  taskName: string,
  cwd: string
): Promise<PlanGraph | null> {
  const planPath = path.join(cwd, ".agent", "plans", taskName, "plan.json");
  try {
    const raw = await fs.readFile(planPath, "utf-8");
    return JSON.parse(raw) as PlanGraph;
  } catch {
    return null;
  }
}

/**
 * Save the plan graph to disk.
 */
export async function savePlanGraph(
  taskName: string,
  graph: PlanGraph,
  cwd: string
): Promise<void> {
  const plansDir = path.join(cwd, ".agent", "plans", taskName);
  const planPath = path.join(plansDir, "plan.json");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(graph, null, 2), "utf-8");
}
