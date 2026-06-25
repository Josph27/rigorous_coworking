import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";
import { lockWorkspace } from "../vfs/lockManager.js";
import { buildOmbudsmanPrompt } from "../ombudsman/ombudsman.js";
import type { CoworkMode } from "../types/schema.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Register the /task command.
 *
 * Usage: /task --mode={1|2|3} "task name": description
 *        /task --mode=1 "auth-refactor": Refactor the auth module to support OAuth2
 */
export function registerTaskCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task", {
    description:
      "Initialize a rigorous planning session with a specific coworking mode.",
    handler: async (args, ctx) => {
      try {
        // args can be string, object, or undefined depending on pi version
        const raw = typeof args === "string" ? args : String(args ?? "");
        await handleTaskCommand(raw, pi, ctx);
      } catch (err) {
        console.error("[rigor] /task handler error:", err);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Task command error: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
      }
    },
  });
}

async function handleTaskCommand(
  rawArgs: string,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = getState();

  // Ensure we have a valid string to work with
  if (!rawArgs || typeof rawArgs !== "string") {
    showUsage(ctx);
    return;
  }

  // ── Parse: /task --mode={1|2|3} "task name": description ──
  const modeMatch = rawArgs.match(/--mode[= ]([0123])/i);
  if (!modeMatch || !modeMatch[0] || !modeMatch[1]) {
    showUsage(ctx);
    return;
  }

  const mode = parseInt(modeMatch[1], 10) as CoworkMode;
  if (mode < 0 || mode > 3) {
    showUsage(ctx);
    return;
  }

  // Extract everything after "--mode=X"
  const modeIdx = rawArgs.indexOf(modeMatch[0]);
  const afterMode = (modeIdx >= 0
    ? rawArgs.slice(modeIdx + modeMatch[0].length)
    : rawArgs
  ).trim();

  if (!afterMode) {
    ctx.ui.notify("Missing task name and description after --mode flag.", "error");
    return;
  }

  // Parse: "task name": description block
  let taskName = "";
  let description = "";

  const nameMatch = afterMode.match(/^"([^"]+)"\s*:\s*(.*)/s);
  if (nameMatch && nameMatch[1]) {
    taskName = (nameMatch[1] || "").trim();
    description = (nameMatch[2] || "").trim();
  } else {
    // Fallback: unquoted name or no colon
    const colonIdx = afterMode.indexOf(":");
    if (colonIdx > 0) {
      taskName = (afterMode.slice(0, colonIdx) || "").trim().replace(/^"/, "").replace(/"$/, "");
      description = (afterMode.slice(colonIdx + 1) || "").trim();
    } else {
      taskName = (afterMode || "").trim().replace(/^"/, "").replace(/"$/, "");
      description = taskName;
    }
  }

  if (!taskName || !description) {
    ctx.ui.notify("Task name and description are required.", "error");
    return;
  }

  // Sanitize task name for filesystem
  const safeTaskName = taskName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .substring(0, 64);

  // ── Phase: Initialize ──
  lockWorkspace(safeTaskName);
  state.currentMode = mode;
  state.phase = "ombudsman_analyzing";
  state.ombudsmanIterations = 0;

  const plansDir = path.join(ctx.cwd, ".agent", "plans", safeTaskName);
  await fs.mkdir(plansDir, { recursive: true });

  const modeLabel =
    mode === 0 ? "Stepwise" : mode === 1 ? "Semi-auto" : mode === 2 ? "Continuous" : "Silent";

  const assignmentContent =
    `# Assignment: ${taskName}\n\n` +
    `**Mode:** ${mode} (${modeLabel})\n\n` +
    `## Task Description\n\n${description}\n\n` +
    `## Completeness Conditions\n\n` +
    `_To be refined by Ombudsman._\n`;

  await fs.writeFile(
    path.join(plansDir, "assignment.md"),
    assignmentContent,
    "utf-8"
  );
  state.assignmentText = assignmentContent;

  ctx.ui.notify(
    `Assignment created: .agent/plans/${safeTaskName}/assignment.md\nMode: ${modeLabel}`,
    "info"
  );
  ctx.ui.notify(`Ombudsman analyzing assignment for gaps...`, "info");

  // ── Send Ombudsman analysis prompt ──
  pi.sendUserMessage(buildOmbudsmanPrompt(assignmentContent), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
}

function showUsage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    'Usage: /task --mode={1|2|3} "task name": description\n' +
      "  mode=0  Stepwise — halt every step, /greenlight to advance\n" +
      "  mode=2  Continuous — all steps with complexity alarms\n" +
      "  mode=3  Silent — fully autonomous with upfront cost gate\n\n" +
      'Example: /task --mode=1 "auth-refactor": Refactor auth to use OAuth2',
    "error"
  );
}
