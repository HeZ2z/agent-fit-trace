# agent-fit-trace pi Integration Spec

This document describes the pi Extension + Skill integration component. The broader product is a workout tracking and coaching application targeting hosted cloud and local Codex/pi/OpenCode Agent execution. Local pi is implemented; gated local Codex/OpenCode adapters and the hosted cloud slice exist but are disabled unless their capability probes and operator configuration pass. This specification retains the original pi MVP design and is not a claim that the other paths are production-ready.

## 1. Goal

Provide a pi integration for the training tracking application: the App submits structured workout records, the Extension exposes deterministic domain tools, and the Skill provides training analysis and recommendation rules.

## 2. Layered responsibilities

### Extension

Responsible for deterministic runtime capabilities:

- Register pi tools
- Validate input data
- Store and query training history
- Compute basic metrics
- Return structured results
- Handle errors, versioning, and data migration

The Extension is not responsible for deciding training strategy, nor does it directly output long-form natural-language advice.

### Skill

Responsible for model behavior and domain rules:

- How to interpret metrics and trends
- How to generate recommendations based on goals, recovery status, and constraints
- How to cite data as the basis for recommendations
- How to handle missing data, outliers, and pain
- Unify the output format and tone

The Skill does not read or write files or databases directly, and does not bypass the Extension to modify data.

## 3. Tool interface

### `import_workout`

Input: a single workout record. Output: `{id, accepted, warnings}`.

Reject storage on validation failure; save suspicious-but-acceptable data and return a warning.

### `get_training_history`

Input: `{from?, to?, exercise?, limit?}`. Output: a list of records in ascending date order plus pagination info.

### `analyze_progress`

Input: `{from?, to?, exercises?}`. Output:

```json
{
  "period": {"from": "...", "to": "..."},
  "metrics": {"sessions": 0, "volume": 0, "avg_rpe": 0},
  "trends": [],
  "flags": []
}
```

### `generate_next_plan`

Input: `{goal?, days_available?, equipment?, constraints?}`. Output: a structured plan draft, including a `reason` and cited metrics for each recommendation.

This tool only generates a draft; it does not automatically write back to the training log.

## 4. Data model

Required: `date`, `session_type`, and `exercises`. Each exercise must contain at least a `name` and one set; each set contains `reps`, and strength training usually should also contain `weight`.

Optional: `rpe`, `duration_minutes`, `sleep_hours`, `pain`, `notes`.

Constraints: weight in kg, duration in minutes, RPE in the range 1–10, reps and weight must not be negative; dates use ISO 8601.

Later, the protocol will be formalized with JSON Schema, and `schema_version` will be added to the protocol.

## 5. Skill behavior rules

The Skill must work in the following order:

1. First call the Extension to obtain history and metrics.
2. Distinguish facts, inferences, and recommendations.
3. Cite specific data for each recommendation, or explicitly state that data is insufficient.
4. Prioritize actionable adjustments for the next session (weight, reps, sets, or recovery).
5. When persistent pain, extreme RPE, or clear anomalies are detected, reduce the aggressiveness of training recommendations and suggest seeking professional evaluation.
6. A plan is considered adopted only after the user confirms it.

Standard output: `Session summary`, `Recent trends`, `Watch items`, `Next plan draft`, `Basis`.

## 6. Persistence

The MVP uses local JSON or SQLite (choose one, depending on pi Extension API capabilities). Records are append-only, and the import interface must be idempotent: the same `id` must not be stored twice.

## 7. Acceptance criteria

- Valid records can be imported and queried
- Invalid records are rejected with readable errors
- Analysis results are reproducible from fixed samples
- Plan recommendations cite historical metrics
- The Skill does not fabricate training history when no data has been queried
- Original training records are not modified before user confirmation
