import { Type, type Static } from "typebox";

/**
 * Schema for a single step node in the execution graph.
 * This is part of the strict JSON state machine that the Plan Designer
 * Agent must use when creating/updating the execution plan.
 */
export const StepNodeSchema = Type.Object({
  step_id: Type.Number({
    description: "Unique sequential identifier for the step.",
  }),
  headline: Type.String({
    description: "Concise summary headline of the step.",
  }),
  description: Type.String({
    description: "In-depth execution instructions for this step.",
  }),
  model_target: Type.String({
    description:
      "Target LLM or API model routing (e.g., 'gemini-3.1-pro-preview' or 'default'). Use 'default' for the currently active model.",
  }),
  success_criteria: Type.String({
    description:
      "Measurable completeness criteria for this step (e.g., 'TypeScript compilation succeeds with zero errors', 'All unit tests in __tests__/auth.test.ts pass').",
  }),
  is_completed: Type.Boolean({ default: false }),
});

/**
 * The full execution plan graph.
 * Status transitions: designing -> executing -> finished (or evaluating_exception on error).
 */
export const PlanGraphSchema = Type.Object({
  task_id: Type.String({
    description: "The task identifier name (must match the task directory name).",
  }),
  status: Type.Union(
    [
      Type.Literal("designing"),
      Type.Literal("executing"),
      Type.Literal("evaluating_exception"),
      Type.Literal("finished"),
    ],
    { description: "Current state of the execution graph." }
  ),
  steps: Type.Array(StepNodeSchema, {
    description: "Ordered list of execution steps.",
  }),
});

export type StepNode = Static<typeof StepNodeSchema>;
export type PlanGraph = Static<typeof PlanGraphSchema>;

/**
 * Schema for the assignment completeness check result
 * produced by the Ombudsman's verification.
 */
export const AssignmentCheckSchema = Type.Object({
  is_complete: Type.Boolean({
    description: "Whether the assignment has all required information.",
  }),
  gaps: Type.Array(
    Type.Object({
      category: Type.Union([
        Type.Literal("missing_steps"),
        Type.Literal("ambiguous_outcome"),
        Type.Literal("unverified_completeness"),
        Type.Literal("missing_context"),
        Type.Literal("scope_too_broad"),
      ]),
      description: Type.String({
        description: "Human-readable description of what's missing.",
      }),
      question: Type.String({
        description: "Specific question to ask the user to resolve this gap.",
      }),
    })
  ),
});

export type AssignmentCheck = Static<typeof AssignmentCheckSchema>;

/**
 * Coworking mode enum.
 *   0 = Stepwise: halt after every step, /greenlight to advance
 *   1 = Semi-auto: auto-proceed on success, halt on failure or at stop points
 *   2 = Continuous: run all steps with complexity alarms, halt at stop points
 *   3 = Silent: fully autonomous, ignores stop points unless critical
 */
export type CoworkMode = 0 | 1 | 2 | 3;
