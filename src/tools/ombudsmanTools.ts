import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssignmentCheckSchema, type AssignmentCheck } from "../types/schema.js";
import { getState } from "../state.js";

/**
 * Register the Ombudsman's gap analysis tool.
 *
 * This is the structured interface the LLM MUST use to report
 * assignment gaps. The LLM calls this tool with a typed payload
 * matching AssignmentCheckSchema — no raw JSON parsing needed.
 *
 * The tool handler stores the result in extension state so the
 * orchestrator can react to it.
 */
export function registerOmbudsmanTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_gap_analysis",
    label: "Submit Gap Analysis",
    description:
      "Submit the results of an assignment gap analysis. " +
      "Call this tool after thoroughly analyzing a task assignment for " +
      "missing steps, ambiguous outcomes, unverified completeness conditions, " +
      "missing context, or overly broad scope.",
    promptSnippet:
      "Analyze a task assignment and submit identified gaps via submit_gap_analysis",
    promptGuidelines: [
      "Use submit_gap_analysis to report assignment gaps. Be exhaustive — flag every ambiguity, missing detail, or derailment path. If the assignment is perfect, set is_complete to true with an empty gaps array.",
      "For each gap, provide: category (one of: missing_steps, ambiguous_outcome, unverified_completeness, missing_context, scope_too_broad), a specific description of what is missing, and a concrete question that would fully resolve the gap.",
    ],
    parameters: AssignmentCheckSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const analysis = params as AssignmentCheck;
      const state = getState();

      // Store the analysis result for the orchestrator to pick up
      state._pendingGapAnalysis = analysis;

      const gapCount = analysis.gaps.length;
      const summary = analysis.is_complete
        ? "Assignment verified: no gaps found."
        : `${gapCount} gap(s) identified.`;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Ombudsman: ${summary}`,
          analysis.is_complete ? "success" : "warning"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: analysis.is_complete
              ? "Gap analysis complete. Assignment is fully specified with no ambiguities."
              : `Gap analysis: ${gapCount} issue(s) found.\n\n` +
                analysis.gaps
                  .map(
                    (g, i) =>
                      `${i + 1}. [${g.category}] ${g.description}\n   → ${g.question}`
                  )
                  .join("\n\n"),
          },
        ],
        details: {
          isComplete: analysis.is_complete,
          gapCount,
          gaps: analysis.gaps,
        },
      };
    },
  });
}
