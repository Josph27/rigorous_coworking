import type { PlanGraph, CoworkMode, AssignmentCheck } from "../types/schema.js";

/**
 * Phases of the rigorous coworking state machine.
 *
 *   idle                → No active task
 *   ombudsman_analyzing → Waiting for LLM gap analysis response
 *   ombudsman_modal     → Showing TUI modal for user clarification
 *   planning            → Plan Designer is creating the execution graph
 *   plan_review          → Plan is ready, waiting for user feedback or /greenlight
 *   executing           → Orchestrator is running steps
 *   evaluating_exception → Mode 2 complexity alarm triggered, needs user attention
 *   finished            → All steps complete
 */
export type TaskPhase =
  | "idle"
  | "ombudsman_analyzing"
  | "ombudsman_modal"
  | "planning"
  | "plan_review"
  | "executing"
  | "evaluating_exception"
  | "finished";

/**
 * Central state store for the rigorous coworking extension.
 */
export interface ExtensionState {
  /** Whether the global VFS workspace lock is engaged. */
  isLocked: boolean;
  /** Active task identifier (directory name under .agent/plans/). */
  activeTask: string | null;
  /** Current phase of the state machine. */
  phase: TaskPhase;
  /** Coworking mode (1=stepwise, 2=continuous, 3=silent). */
  currentMode: CoworkMode | null;
  /** Index of the current step being executed (0-based, for mode 1). */
  currentStepIndex: number;
  /** Whether the orchestrator is in a final I/O sweep and /status should be inhibited. */
  isFinishingGraph: boolean;
  /** Whether execution is paused waiting for user /greenlight (mode 1). */
  waitingForGreenlight: boolean;
  /** Loaded plan graph (cached in memory). */
  planGraph: PlanGraph | null;
  /** The current assignment text (accumulated across ombudsman iterations). */
  assignmentText: string;
  /** How many ombudsman iterations have run for the current task. */
  ombudsmanIterations: number;
  /** Pending gap analysis result from the submit_gap_analysis tool (consumed by orchestrator). */
  _pendingGapAnalysis: AssignmentCheck | null;
  /** Gap history across rounds: description + user's answer. Used by Ombudsman to decide whether a gap was truly resolved. */
  gapRoundHistory: Array<{ description: string; answer: string }>;
  /** Internal: number of completed analysis rounds (for display). */
  _ombudsmanRound: number;
  /** Internal: set by /greenlight during ombudsman phases to skip to planning. */
  _earlyGreenlight: boolean;
  /** Stop points: step IDs where execution must halt even in auto modes (1,2). */
  stopPoints: number[];
  /** Internal: spinner frame counter for the task banner widget. */
  _spinnerFrame: number;
  /** Internal: set when /task-extend is active — Plan Designer should append, not replace. */
  _extendMode: boolean;
  _apiErrors: number;
  _lastAssistantTexts: string[];
  _consecutiveLoops: number;
  _consecutiveFailures: number;
}

const state: ExtensionState = {
  isLocked: false,
  activeTask: null,
  phase: "idle",
  currentMode: null,
  currentStepIndex: 0,
  isFinishingGraph: false,
  waitingForGreenlight: false,
  planGraph: null,
  assignmentText: "",
  ombudsmanIterations: 0,
  _pendingGapAnalysis: null,
  gapRoundHistory: [],
  _ombudsmanRound: 0,
  _earlyGreenlight: false,
  stopPoints: [],
  _spinnerFrame: 0,
  _extendMode: false,
  _apiErrors: 0,
  _lastAssistantTexts: [],
  _consecutiveLoops: 0,
  _consecutiveFailures: 0,
};

/** Resolvers for the greenlight gate promise (mode 1 stepwise). */
let greenlightResolvers: Array<() => void> = [];

export function getState(): ExtensionState {
  return state;
}

export function resetState(): void {
  state.isLocked = false;
  state.activeTask = null;
  state.phase = "idle";
  state.currentMode = null;
  state.currentStepIndex = 0;
  state.isFinishingGraph = false;
  state.waitingForGreenlight = false;
  state.planGraph = null;
  state.assignmentText = "";
  state.ombudsmanIterations = 0;
  greenlightResolvers = [];
}

export function addGreenlightResolver(resolve: () => void): void {
  greenlightResolvers.push(resolve);
}

export function resolveGreenlight(): void {
  const resolvers = greenlightResolvers;
  greenlightResolvers = [];
  for (const resolve of resolvers) {
    resolve();
  }
}

export function clearGreenlightResolvers(): void {
  greenlightResolvers = [];
}
