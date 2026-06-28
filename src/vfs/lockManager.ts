import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";

const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
const PLANS_DIR_PREFIX = ".agent/plans/";

const SAFE_BASH_PATTERNS: RegExp[] = [
	/^\s*ls\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*find\b/,
	/^\s*fd\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
	/^\s*npx\s+--version\b/,
	/^\s*cargo\s+--version\b/,
	/^\s*go\s+version\b/,
];

function isSafeReadOnlyBash(command: string): boolean {
	return SAFE_BASH_PATTERNS.some((p) => p.test(command));
}

export function setupVfsInterceptors(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const state = getState();
		if (!state.isLocked) return;

		const readOnlyTools = new Set([
			"read",
			"grep",
			"find",
			"ls",
			"questionnaire",
			"mutate_plan_graph",
			"submit_gap_analysis",
		]);
		if (readOnlyTools.has(event.toolName)) return;

		if (event.toolName === "bash") {
			const command = String(
				(event.input as Record<string, unknown>).command ?? "",
			);
			if (command.includes(".agent/plans/")) return;
			if (isSafeReadOnlyBash(command)) return;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"VFS Locked: bash restricted to read-only commands. Write to .agent/plans/.",
					"error",
				);
			}
			return {
				block: true,
				reason: "VFS Locked: read-only bash only. Write to .agent/plans/.",
			};
		}

		if (MUTATION_TOOLS.has(event.toolName)) {
			const path = String((event.input as Record<string, unknown>).path ?? "");
			if (path && !path.startsWith(PLANS_DIR_PREFIX)) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"VFS Locked: only .agent/plans/ writes allowed.",
						"error",
					);
				}
				return {
					block: true,
					reason: "VFS Locked: write/edit restricted to .agent/plans/.",
				};
			}
		}
	});
}

export function lockWorkspace(taskName: string): void {
	const state = getState();
	state.isLocked = true;
	state.activeTask = taskName;
}
export function unlockWorkspace(): void {
	const state = getState();
	state.isLocked = false;
}
