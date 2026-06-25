# 1. Cowork modes:               
- Presents three coworking modes governed by a strict JSON execution graph, ranging from most to least user guidance needed.
- Commands:
  { /task --mode={1|2|3} "task_name": task description block ...
      -> /greenlight
      -> /status
  }
- VFS Split-Path Locking: Initiating `/task` applies a read-only lock to the global workspace while whitelisting the `.agent/plans/` directory. No global implementation writing is possible until design mode is closed and the workspace is unlocked via `/greenlight`.
- Introduces:
    -> .agent/plans/task_name/assignment.md => Single source of truth specifying exact expected output (measurable completeness condition) and tool/approach constraints. Managed deterministically by the Ombudsman.
    -> .agent/plans/task_name/plan.json     => The strict state-machine execution graph generated exclusively via native LLM tool calling.
- Dependencies: {JSON State Machine, TUI Ombudsman Modal, Structured Plan Designer, VFS Lock Manager}


# 1.1 Multi Model assignments:

- Eliminates error-prone Markdown text parsing (`#{MODEL=...}`). Model routing is handled natively as a key-value pair inside the step nodes of `plan.json`.
-> e.g., `"step_id": 2, "model_target": "gemini-3.1-pro-preview", "headline": "Backcheck generated JSONs in @src/data/..."`
- The orchestrator dynamically binds the assigned API client as it traverses the execution graph.


# 1.2 Assignment ombudsman:

- TUI Ombudsman Modal: Replaces open-ended conversational loops with a deterministic Terminal UI modal.
- Analyzes raw user task input against a strict matrix: missing implementation steps, ambiguous outcomes, and unverified completeness conditions.
- Execution Flow:
    -> Intercepts `/task` -> renders structured TUI questionnaire for detected oversights.
    -> Captures user input -> programmatically overwrites `assignment.md`.
    -> Re-evaluates updated markdown -> repeats TUI modal cycle *only* if ambiguities persist.
    -> Completeness condition verified (automated pipeline or defined manual check) -> yields control to Plan Designer Agent.


# 1.3 Plan designer agent:

- Gathers Information: Interrogates local environment for available APIs (purpose/rate limits) and registered workspace tools. Solicits external tool definitions only if local substitution is mathematically or logically unviable.
- Strict JSON Interface: Absolutely prohibited from writing or editing plan files via raw text generation. Must interact with the plan exclusively by invoking a strongly-typed tool call yielding the exact schema:
  {
    "task_id": "string",
    "status": "string",
    "steps": [
      {
        "step_id": 1,
        "headline": "string",
        "description": "string",
        "model_target": "string",
        "success_criteria": "string",
        "is_completed": false
      }
    ]
  }
- Programmatic Summary Generation: Zero LLM overhead for user review. The terminal parses `plan.json` and renders a clean, un-padded bullet point list of `"headline"` values.
- Natural Correction Loop: User critiques the printed headline list via standard chat -> Agent processes constraints, isolates faulty `step_id`s, and invokes the JSON tool call to rewrite the graph. Repeats until `/greenlight`.


## 1.4.1 Cowork mode 1 (/task --mode=1):

- Collapsed Initialization: User issues `/task --mode=1 "task name": implement ...` (VFS global lock engages).
- Definition: Ombudsman resolves `assignment.md` -> SotA Agent tool-calls `plan.json` (defining fallback branches for volatile steps and software test success criteria).
- Briefing: Terminal programmatically displays `plan.json` headline list.
- User Review Loop:
    -> Standard Chat Input => User points out flaws; Agent tool-updates JSON, terminal re-renders bullet points.
    -> /greenlight         => Releases global VFS lock; Orchestrator initiates Step 1.
- Stepwise Implementation:
    -> Orchestrator executes step -> halts immediately upon step completion.
    -> Programmatically outputs current step success evaluation.
    -> Renders progress -> awaits explicit `/greenlight` before unpausing to execute Step n+1.
- Implementation Exceptions: Re-engages VFS lock -> Agent tool-calls revised `plan.json` -> awaits `/greenlight`.
- Implementation Finished: 
    -> Programmatically print verified success criteria.
    -> State tokens burnt during user communication vs. autonomous execution.


## 1.4.2 Cowork mode 2 (/task --mode=2):

- Collapsed Initialization: User issues `/task --mode=2 "task name": implement ...` (VFS global lock engages).
- Definition: Ombudsman resolves `assignment.md` -> SotA Agent tool-calls `plan.json`.
- Briefing: Terminal programmatically displays `plan.json` headline list.
- User Review Loop: Standard chat correction -> tool-call JSON update -> `/greenlight` granted (VFS unlocks).
- Autonomous Batch Implementation: Orchestrator traverses `plan.json` nodes continuously without per-step halting.
- Active Supervision: User can poll progress via `/status` (call is automatically inhibited/queued during high-I/O graph finishing states to prevent race conditions).
- Bounded Autonomous Healing: On step failure, SotA agent attempts local branch resolution. Evaluates graph delta: *only* triggers TUI alarm to interrupt user if the fix significantly inflates graph complexity or compute costs.
- Implementation Finished:
    -> Programmatically print verified success criteria.
    -> State tokens burnt during user communication vs. autonomous execution.


## 1.4.3 Cowork mode 3 (/task --mode=3):

- Collapsed Initialization: User issues `/task --mode=3 "task name": implement ...` (VFS global lock engages).
- Definition: Ombudsman resolves `assignment.md` -> SotA Agent tool-calls `plan.json`.
- Upfront Cost Gating: Planning agent evaluates total graph complexity. If extreme token/cost anomalies are detected, halts and triggers TUI alarm.
- Instant Trigger: If cost is nominal, auto-applies `/greenlight` internally -> releases VFS lock -> initiates execution instantly. Skip user briefing entirely.
- Fully Autonomous Implementation: Runs silently to completion. Visibility strictly limited to manual `/status` polling.
- Implementation Finished:
    -> Programmatically print verified success criteria.
    -> State tokens burnt during user communication vs. autonomous execution.
