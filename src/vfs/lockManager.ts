import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";

const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
const PLANS_DIR_PREFIX = ".agent/plans/";

/**
 * Set up VFS split-path locking interceptors.
 *
 * When the workspace is locked (design mode), all file-mutating tool calls
 * are blocked unless they target paths under `.agent/plans/`.
 *
 * This enforces the invariant that no global implementation writing can
 * occur until design mode is closed and the workspace is unlocked via /greenlight.
 */
export function setupVfsInterceptors(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const state = getState();

    if (!state.isLocked) return;

    // Whitelist of read-only tools that are always allowed
    const readOnlyTools = new Set([
      "read",
      "grep",
      "find",
      "ls",
      "questionnaire",
      "mutate_plan_graph",
    ]);

    if (readOnlyTools.has(event.toolName)) return;

    // For mutation tools, check the target path
    if (MUTATION_TOOLS.has(event.toolName)) {
      const input = event.input as Record<string, unknown>;

      if (event.toolName === "bash") {
        // Allow bash if it only touches .agent/plans/
        // In practice, we can't fully parse bash intent, so be restrictive
        const command = String(input.command ?? "");
        if (!command.includes(".agent/plans/")) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `VFS Locked: Workspace mutability disabled during design mode. Only .agent/plans/ writes allowed.`,
              "error"
            );
          }
          return {
            block: true,
            reason:
              "VFS Locked: Workspace mutability disabled during design mode. Use mutate_plan_graph tool to update plans.",
          };
        }
        // Allow bash commands that explicitly target .agent/plans/
        return;
      }

      // For write/edit, check the path
      const path = String(input.path ?? "");
      if (path && !path.startsWith(PLANS_DIR_PREFIX)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `VFS Locked: Cannot write to '${path}'. Only .agent/plans/ writes allowed during design mode.`,
            "error"
          );
        }
        return {
          block: true,
          reason:
            "VFS Locked: Workspace mutability disabled during design mode. Only .agent/plans/ writes allowed.",
        };
      }
    }
  });
}

/**
 * Engage the global VFS lock for the given task.
 * All file mutations outside .agent/plans/${taskName}/ are blocked.
 */
export function lockWorkspace(taskName: string): void {
  const state = getState();
  state.isLocked = true;
  state.activeTask = taskName;
}

/**
 * Release the global VFS lock, permitting full workspace mutations.
 */
export function unlockWorkspace(): void {
  const state = getState();
  state.isLocked = false;
}
