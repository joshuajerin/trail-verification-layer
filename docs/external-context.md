# External human context

TRAIL treats the current human request as the highest-authority task input. Approved historical trails are evidence-backed execution guidance, not replacement instructions.

## Bundle lifecycle

1. `compile` receives the task, trigger, and detected or explicit environment.
2. K3 may extract structured intent, but every current-request directive must cite an exact contiguous source quote. Invalid model output is discarded and a deterministic local fallback is used.
3. Retrieval rejects environment mismatches, vague intent matches, and candidates outside the final applicability margin.
4. A deterministic template renders Current Request, Do, Do Not, Route, Evidence, recovery behavior, and release rule.
5. The bundle is stored immutably in the router's private route-session store; the deployed knowledge schema persists its reviewed corpus and route lineage. Local SQLite remains the development and curator store.
6. `recover` creates one child bundle. A second recovery request creates a blocked bundle and requires escalation.
7. `trail_verify` evaluates reported evidence but labels agent claims advisory. Only CI or a signed harness runs built-in checks and commands or probes named by the repository owner in `.trailrc.json`, then submits trusted proof.

## Authority order

1. Current user request, preserved verbatim.
2. Literal current-request constraints with exact source quotes.
3. Approved, environment-compatible human trails.
4. Generic bounded verification behavior when no trail applies.

Trail content cannot create tools, commands, permissions, adapters, or merge authority. GitHub publication remains an exact-commit status operation and TRAIL never merges.
