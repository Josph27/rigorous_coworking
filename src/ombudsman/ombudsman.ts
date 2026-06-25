import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Construct the Ombudsman analysis prompt.
 */
export function buildOmbudsmanPrompt(
  assignmentText: string,
  gapRoundHistory: Array<{ description: string; answer: string }> = []
): string {
  const historyBlock =
    gapRoundHistory.length > 0
      ? `\nPRIOR ROUNDS:\n` +
        gapRoundHistory
          .map(
            (h, i) =>
              `  R${i + 1}: ${h.description} → answer: ${h.answer}`
          )
          .join("\n") +
        `\n\nDEDUP: re-flag ONLY if the answer did not resolve the gap. If re-flagging, state why it was insufficient.\n`
      : `\nDEDUP: never flag the same concern twice in one response; merge overlapping gaps.\n`;

  return `[SYSTEM: Assignment Ombudsman — Strict Semantic Analysis]

Find EVERY gap, ambiguity, missing detail, or derailment path in this assignment.
Flag anything the agent could plausibly misunderstand, shortcut, or skip verifying.

Categories:
  missing_steps          — vague/incomplete steps, missing preconditions
  ambiguous_outcome      — subjective/unmeasurable success criteria
  unverified_completeness — no runnable command or observable artifact to confirm done
  missing_context        — unspecified files, frameworks, APIs, dependencies
  scope_too_broad        — no clear boundary, could spiral

RULES:
  - Multi-way interpretation → FLAG IT.
  - Missing concrete path/package/endpoint/data-shape → FLAG IT.
  - No runnable verification → FLAG IT.
  - Exhaustive: better to over-flag than miss.
  - Perfect assignment → is_complete:true, gaps:[].

ORDERING (CRITICAL):
  Sort gaps by relevance to the user. Visual, output, and UX concerns first.
  Technical implementation questions last. The user cares about what they SEE
  and GET before how it's BUILT.

STYLE (CRITICAL):
  - descriptions: information-dense, clipped. No filler words. No grammatical padding.
    Wrong: "The assignment does not specify which 3D rendering library should be used
    for implementing the rotating cube animation, which creates ambiguity."
    Right: "No 3D library specified (Three.js? WebGL? canvas?)"
  - questions: direct, single-line. "Which library?" not "Could you please specify
    which library you would prefer to use for this task?"
  - Max ~140 chars per description, ~80 chars per question. Be terse.

${historyBlock}
PROCEDURE:
  1. Analyze the assignment.
  2. Identify gaps across all five categories.
  3. Sort: visual/output/UX concerns → technical implementation last.
  4. Write terse description + direct question for each.
  5. Call submit_gap_analysis tool.
  6. No raw text output — use the tool.

═══════════════════════════════════════════════════════════════
ASSIGNMENT:
═══════════════════════════════════════════════════════════════
${assignmentText}
═══════════════════════════════════════════════════════════════

Call submit_gap_analysis now.`;
}

// ── Editor template (compact flat format) ──

const CAT_LABEL: Record<string, string> = {
  missing_steps: "missing_steps",
  ambiguous_outcome: "ambiguous",
  unverified_completeness: "unverified",
  missing_context: "no_context",
  scope_too_broad: "too_broad",
};

function buildEditorTemplate(
  gaps: Array<{ category: string; description: string; question: string }>,
  taskName: string
): string {
  let t = `# Ombudsman: ${gaps.length} gap(s) for "${taskName}"\n`;
  t += `# Submit empty to skip ALL gaps (they'll be marked "left to agent discretion").\n`;
  t += `# Then use /greenlight to proceed directly to planning.\n`;
  t += `# Or: write answers on the blank lines below, delete any block to skip it.\n\n`;

  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    t += `=== GAP ${i + 1} | ${CAT_LABEL[g.category] || g.category} ===\n`;
    t += `Q: ${g.question}\n`;
    t += `\n`;
  }

  t += `=== END ===\n`;
  return t;
}

/**
 * Parse editor response.
 * Splits on "=== GAP N |" delimiters, extracts text between Q: line and next delimiter.
 */
function parseEditorResponse(raw: string, gapCount: number): string[] {
  const answers: string[] = [];

  for (let i = 1; i <= gapCount; i++) {
    const header = `=== GAP ${i} |`;
    const startIdx = raw.indexOf(header);
    if (startIdx < 0) {
      answers.push("");
      continue;
    }

    const afterHeader = raw.slice(startIdx + header.length);
    const qLineEnd = afterHeader.indexOf("\n");
    const afterQ = qLineEnd >= 0 ? afterHeader.slice(qLineEnd + 1) : afterHeader;

    const nextGap = afterQ.search(/=== GAP \d+ \|/);
    const endMarker = afterQ.indexOf("=== END ===");
    let endIdx = afterQ.length;
    if (nextGap >= 0) endIdx = Math.min(endIdx, nextGap);
    if (endMarker >= 0) endIdx = Math.min(endIdx, endMarker);

    const answer = afterQ.slice(0, endIdx).trim();
    if (!answer || answer.startsWith("#")) {
      answers.push("");
    } else {
      answers.push(answer);
    }
  }

  while (answers.length < gapCount) answers.push("");
  return answers;
}

/**
 * Run the Ombudsman TUI modal — single compact editor for all gaps.
 *
 * Unanswered gaps are marked "left to agent discretion" in the assignment
 * so the Plan Designer knows they were intentionally skipped.
 */
export async function runOmbudsmanModal(
  gaps: Array<{
    category: string;
    description: string;
    question: string;
  }>,
  taskName: string,
  assignmentText: string,
  ctx: ExtensionContext
): Promise<{ assignment: string; answers: string[] }> {
  if (!ctx.hasUI) return { assignment: assignmentText, answers: [] };

  const template = buildEditorTemplate(gaps, taskName);

  const userResponse = await ctx.ui.editor(
    `Ombudsman: ${gaps.length} gap(s) for "${taskName}"`,
    template
  );

  if (!userResponse || userResponse.trim() === template.trim()) {
    // User submitted empty — mark all as "left to agent"
    return markAllUnresolved(assignmentText, gaps, []);
  }

  const answers = parseEditorResponse(userResponse, gaps.length);

  // Append clarifications to assignment
  return buildUpdatedAssignment(assignmentText, gaps, answers);
}

/**
 * Build the updated assignment with clarifications.
 * Unanswered gaps receive a "left to agent discretion" marker.
 */
export function buildUpdatedAssignment(
  assignmentText: string,
  gaps: Array<{ category: string; description: string }>,
  answers: string[]
): { assignment: string; answers: string[] } {
  const catLabels: Record<string, string> = {
    missing_steps: "Missing Steps",
    ambiguous_outcome: "Ambiguous Outcome",
    unverified_completeness: "Unverified Completeness",
    missing_context: "Missing Context",
    scope_too_broad: "Scope Too Broad",
  };

  let updated = assignmentText;
  let answeredCount = 0;

  for (let i = 0; i < gaps.length; i++) {
    const answer = answers[i];
    if (answer) {
      const gap = gaps[i];
      const label = catLabels[gap.category] || gap.category;
      updated +=
        `\n\n## Ombudsman Clarification — ${label}\n` +
        `**Gap:** ${gap.description}\n` +
        `**Response:** ${answer}\n`;
      answeredCount++;
    }
  }

  // Append a block listing all unresolved gaps as "left to agent discretion"
  const unresolved = gaps.filter((_, i) => !answers[i]);
  if (unresolved.length > 0) {
    updated += `\n\n## Unresolved Gaps (left to agent discretion)\n\n`;
    updated += `The following gaps were flagged by the Ombudsman but not clarified by the user.\n`;
    updated += `The agent should decide the best approach for each:\n\n`;
    for (const gap of unresolved) {
      const label = catLabels[gap.category] || gap.category;
      updated += `- [${label}] ${gap.description}\n`;
    }
    updated += `\n`;
  }

  if (answeredCount > 0 || unresolved.length > 0) {
    // Only notify if something changed
  }

  return { assignment: updated, answers };
}

/**
 * Mark all gaps as unresolved (user submitted empty editor).
 */
export function markAllUnresolved(
  assignmentText: string,
  gaps: Array<{ category: string; description: string }>,
  _answers: string[]
): { assignment: string; answers: string[] } {
  return buildUpdatedAssignment(assignmentText, gaps, gaps.map(() => ""));
}
