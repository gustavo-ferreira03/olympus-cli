# Olympus CLI _(Gustavo's Fork)_

A maintained TypeScript CLI for Project Olympus on Shipd, based on the [@shipd-ai/olympus-cli npm package](https://www.npmjs.com/package/@shipd-ai/olympus-cli).

Use it to inspect and edit challenges, run prechecks and quality checks, manage Docker-backed verification, review rollouts, handle later-stage audits, and automate long-running operations without external polling scripts.

## Contents

- [Installation](#installation)
- [Get started](#get-started)
- [Command overview](#command-overview)
- [Inspect a challenge](#inspect-a-challenge)
- [Live terminal dashboard](#live-terminal-dashboard)
- [Build the version image](#build-the-version-image)
- [Prechecks and quality checks](#prechecks-and-quality-checks)
- [Scope Gate and later-stage reviews](#scope-gate-and-later-stage-reviews)
- [Rollouts](#rollouts)
- [Artifact output without external tools](#artifact-output-without-external-tools)
- [JSON behavior for agents](#json-behavior-for-agents)
- [Download a challenge locally](#download-a-challenge-locally)
- [Create, edit, and version drafts](#create-edit-and-version-drafts)
- [Policy](#policy)
  - [Action graph](#action-graph)
- [Environment](#environment)
- [Development](#development)

## Installation

Requires Node.js 20 or newer and pnpm. This repository is installed from source; the package is marked private and self-update is disabled unless explicitly configured. `policy edit` additionally requires `flock` (util-linux), so use Linux/WSL or a Linux SSH host for that command.

```bash
git clone https://github.com/gustavo-ferreira03/olympus-cli.git
cd olympus-cli
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
```

Verify the installation:

```bash
command -v olympus
olympus --version
olympus --help
```

## Get started

Sign in:

```bash
olympus auth login
olympus auth whoami
```

Inspect a challenge:

```bash
olympus problems view <challenge-id>
olympus problems view <challenge-id> --json
```

The JSON form is compact by default and includes safe next commands for deeper inspection.

## Command overview

```text
olympus auth             Authentication
olympus problems         Challenge metadata, artifacts, versions, and submission
olympus checks           Prechecks, quality checks, findings, and readiness
olympus image            Version image build, status, waiting, and cancellation
olympus scope-gate       Scope Gate inspection and execution
olympus fp-check         False-positive check inspection and execution
olympus verifier-audit   Verifier Completeness Audit and decisions
olympus auto-review      Auto Review inspection and execution
olympus contest          Quality-check contests
olympus runs             Rollout batches, runs, artifacts, and re-evaluation
olympus tokens           Token balance, usage history, and challenge costs
olympus policy           Policy rules and optional action graph
olympus dashboard        Read-only terminal dashboard with polling
olympus schema           JSON command discovery from the running CLI
```

Run `olympus <command> --help` for the exact arguments accepted by a command.
Groups without an action display their own help. `olympus schema` emits the
declared command tree as JSON; `olympus schema runs run` selects one command.
The manifest includes paths, metadata, argument definitions, declared defaults,
aliases, flags and child names. Undeclared response schemas and examples are not invented.

## Inspect a challenge

Compact metadata, artifact presence, and readiness:

```bash
olympus problems view <challenge-id> --json
```

Select compact fields:

```bash
olympus problems view <challenge-id> --json --fields=metadata,readiness
olympus problems view <challenge-id> --json --fields=description
```

Available fields:

```text
metadata
artifacts
readiness
description
```

Request the complete response only when necessary:

```bash
olympus problems view <challenge-id> --json --full
```

## Live terminal dashboard

```bash
olympus dashboard                      # account overview; choose a challenge
olympus dashboard <challenge-id>       # open one challenge directly
olympus dashboard <challenge-id> --interval=5
olympus dashboard <challenge-id> --json
olympus dashboard --json               # one overview snapshot
```

Without an ID, the interactive dashboard shows account metrics and a selectable
challenge list. Archived challenges are hidden by default. Use
`--include-archived` to show them, or combine `--status`, `--language`,
`--difficulty` and `--category` to filter the overview. Filter values are
case-insensitive; `all` clears a filter. The filter state remains available in
`--json` output.

Use Up/Down (or PgUp/PgDn) to select a challenge and Enter to open its live
monitor. Press `b` or Escape in the monitor to return to the overview; `q` exits
and `r` refreshes. The overview contains the Home summary, Account information
and the selectable Challenges list. The detail monitor displays the selected
challenge state.

Colors are emitted only in a TTY; set `NO_COLOR` to disable them.

The account telemetry is also available without opening the TUI:

```bash
olympus tokens balance --json
olympus tokens usage --json
olympus tokens usage --json --from 2026-09-14 --to 2026-09-15
```

`tokens balance` exposes the current tier, cap, drip, acceptance-window and
lifetime counters, next-tier requirement, and feature flags. `tokens usage`
provides grants, spending totals and usage bins for the selected period.

## Build the version image

Inspect the image state:

```bash
olympus image view <challenge-id> --json
```

Build or rebuild and wait until the image is ready:

```bash
olympus image build <challenge-id> --wait --json
```

Without `--wait`, the response includes the exact `image wait` command and build job ID:

```bash
olympus image build <challenge-id> --json
olympus image wait <challenge-id> --job=<job-id> --json
```

Cancel an active build:

```bash
olympus image cancel <challenge-id> --json
```

`image build` is idempotent. If the image is already current and rebuild-safe, it returns `status: "ready"` without queuing another build.

## Prechecks and quality checks

Run prechecks:

```bash
olympus checks run-prechecks <challenge-id> --json
olympus checks run-prechecks <challenge-id> --wait --json
```

Inspect current state:

```bash
olympus checks view <challenge-id>
olympus checks view <challenge-id> --json
```

Filter the compact JSON response:

```bash
olympus checks view <challenge-id> --json --only=failed
olympus checks view <challenge-id> --json --only=stale
olympus checks view <challenge-id> --json --only=running
olympus checks view <challenge-id> --json --only=actionable
olympus checks view <challenge-id> --json --check=solutionQuality
```

Paginate check lists:

```bash
olympus checks view <challenge-id> --json --limit=10 --offset=0
```

Run one check and wait for its exact job:

```bash
olympus checks run <challenge-id> --check=descriptionQuality --wait --json
olympus checks run <challenge-id> --check=testQuality --wait --json
olympus checks run <challenge-id> --check=solutionQuality --wait --json
```

Run the production check set:

```bash
olympus checks run-all <challenge-id> --wait --json
```

Current public check keys:

```text
verifyTests
verifySolution
verifyFlakiness
testQuality
taskQuality
solutionQuality
descriptionQuality
```

Later-stage checks use their dedicated commands:

```text
autoReview
verifierIncompleteness
```

### Wait separately

Prefer integrated `--wait`. When separate waiting is useful, always select the intended work:

```bash
olympus checks wait <challenge-id> --job=<job-id> --json
olympus checks wait <challenge-id> --check=testQuality --json
olympus checks wait <challenge-id> --checks=verifyTests,testQuality --json
olympus checks wait-prechecks <challenge-id> --version=<version> --baseline=<stage-baseline> --json
```

An unscoped wait watches only active current checks and returns a compact `idle` response when none exist.

### Inspect one result or finding

```bash
olympus checks show <challenge-id> solutionQuality --json
olympus checks finding <challenge-id> solutionQuality 1 --json
olympus checks finding <challenge-id> solutionQuality 1 --max-chars=2000 --json
```

Use `--full` on `checks show` only when the complete raw result is required.

## Scope Gate and later-stage reviews

Scope Gate:

```bash
olympus scope-gate view <challenge-id> --json
olympus scope-gate run <challenge-id> --json
olympus scope-gate wait <challenge-id> --json
```

False-positive check:

```bash
olympus fp-check view <challenge-id> --json
olympus fp-check run <challenge-id> --json
olympus fp-check wait <challenge-id> --json
```

Verifier Completeness Audit:

```bash
olympus verifier-audit view <challenge-id> --json
olympus verifier-audit run <challenge-id> --wait --json
olympus verifier-audit decide <challenge-id> --decision=accepted --json
olympus verifier-audit decide <challenge-id> --decision=accepted_with_edits --patch-file=test.patch --json
olympus verifier-audit decide <challenge-id> --decision=rejected --json
```

Auto Review:

```bash
olympus auto-review view <challenge-id> --json
olympus auto-review run <challenge-id> --wait --json
olympus auto-review wait <challenge-id> --json
```

Quality-check contests:

```bash
olympus contest view <challenge-id> --json
olympus contest description <challenge-id> --json
olympus contest test-quality <challenge-id> --note="<reason>" --json
olympus contest solution <challenge-id> --note="<reason>" --json
olympus contest task-as-mars <challenge-id> --json
```

## Rollouts

Inspect current rollout batches:

```bash
olympus runs view <challenge-id> --json
```

The compact response summarizes each batch by status and verdict. Expand one batch only when needed:

```bash
olympus runs view <challenge-id> --json --batch=<batch-tag>
olympus runs view <challenge-id> --json --batch=<batch-tag> --limit=10 --offset=0
```

Filters:

```bash
olympus runs view <challenge-id> --json --only=passing
olympus runs view <challenge-id> --json --only=failed
olympus runs view <challenge-id> --json --only=running
olympus runs view <challenge-id> --json --only=scratched
```

Stale history is opt-in:

```bash
olympus runs view <challenge-id> --json --include-stale
```

Inspect presets and trigger rollouts:

```bash
olympus runs presets <challenge-id> --json
olympus runs run <challenge-id> --preset=quick --wait --json
olympus runs run <challenge-id> --preset=full --wait --json
olympus runs run <challenge-id> --solver=nova --evaluator=orion --count=3 --wait --json
```

Wait separately by exact target:

```bash
olympus runs wait <challenge-id> --job=<job-id> --json
olympus runs wait <challenge-id> --run=<run-id> --json
olympus runs wait <challenge-id> --batch=<batch-tag> --json
```

Inspect and manage one run:

```bash
olympus runs show <challenge-id> <run-id> --json
olympus runs cancel <challenge-id> <run-id> --json
olympus runs scratch <challenge-id> <run-id> --reason="<reason>" --json
olympus runs scratch <challenge-id> <run-id> --undo --json
```

Re-evaluation:

```bash
olympus runs re-evaluate view <challenge-id> --json
olympus runs re-evaluate run <challenge-id> --wait --json
```

## Artifact output without external tools

Both check and rollout artifacts support native slicing:

```bash
olympus checks artifact <challenge-id> verifyTests --key=testLog --tail=100 --json
olympus checks artifact <challenge-id> verifyTests --key=testLog --contains="FAIL" --json
olympus runs artifact <challenge-id> <run-id> --key=solutionPatch --head=100 --json
olympus runs artifact <challenge-id> <run-id> --key=evalLog --max-chars=12000 --json
```

Available selectors:

```text
--head=<lines>
--tail=<lines>
--contains=<text>
--max-chars=<characters>
--full
```

JSON artifacts are capped at 12,000 characters by default. A truncated response reports total, returned, and omitted characters plus a command for retrieving the complete artifact.

## JSON behavior for agents

Machine-readable commands follow these rules:

- stdout contains exactly one JSON document;
- polling progress is suppressed in JSON mode;
- command exceptions preserve `status`, the text `error`, and policy `rule`/details, and add `kind`, `code`, `retryable` and `hint`;
- empty waits return `status: "idle"` instead of historical payloads;
- null and empty fields are removed from compact responses;
- large raw payloads require `--full`;
- paginated responses include `nextCommand` when more data exists;
- wait commands retry transient connection failures while polling.

Error kinds include `usage`, `auth`, `permission`, `not_found`, `rate_limit`,
`network`, `config`, `policy`, `budget` and `unknown`. Unknown failures use
`retryable: null`. A transient error should be inspected before retrying a paid
request. Existing exit codes and `--json` behavior remain stable.


## Download a challenge locally

```bash
olympus problems download <challenge-id>
cd olympus-<challenge-id>-v<version>
make clone
make build-image
```

The generated directory includes the canonical challenge artifacts and a Makefile for local repository setup.

## Create, edit, and version drafts

```bash
olympus problems create --title="My draft" --json
olympus problems edit <challenge-id> --description-file=task.md --json
olympus problems version list <challenge-id> --json
olympus problems version view <challenge-id> --version=1 --json
olympus problems version compare <challenge-id> --from=0 --to=1 --json
olympus problems version create <challenge-id> --from=1 --json
olympus problems lock <challenge-id> --json
olympus problems unlock <challenge-id> --json
olympus problems start-edit <challenge-id> --json
```

Submission remains explicit:

```bash
olympus problems submit <challenge-id> --json
```

## Policy

Policies define permissions, limits and optional action-graph requirements.
Validation occurs when the policy is loaded; decisions are evaluated when the
corresponding command runs.

`policy show` displays configured rules and graph nodes. Use `--full` to expand
predicates, arguments and notes. With a challenge ID, it also displays the
current state relevant to those rules. Colors are TTY-only and respect
`NO_COLOR`.

```bash
olympus policy show                        # human rules and graph, no API calls
olympus policy show --full                 # expanded human policy definitions
olympus policy show <challenge-id>         # current blockers and suggestions
olympus policy show --json                 # effective configuration, no API calls
olympus policy show <challenge-id> --json  # configuration plus state-aware decisions
olympus policy show <challenge-id> --full --json  # also include canonical state
```

For agent-authored policies, discover the contract instead of guessing field names
or graph behavior:

```bash
olympus schema policy --json                # policy schema, action catalog and examples
olympus schema --json                       # same contract plus the full CLI schema
olympus policy init --json                  # optional human/editor starter
olympus policy edit <key> <yaml-value> --json  # typed single-key update
```

The `policyAuthoring` object returned by `olympus schema policy` is the source of
truth for policy creation. It contains the JSON Schema, canonical root keys,
all governable actions with their CLI commands and configurable arguments,
valid predicate operators, omission/null semantics, and minimal YAML examples.
Agents should select only actions from `actionCatalog`, write only schema-valid
YAML, and keep `graph: null` unless they intentionally declare sequencing. The
CLI does not infer edges, gates, defaults, or a start action from omitted fields.

Contextual inspection uses the same core decision evaluator as dispatch. Check
allowlists, request-size limits, passing-check protection and graph requirements
appear together. `executionPreflight: required` distinguishes inspection from
execution permission. Exact arguments, cross-version capacity, live costs, balance,
budget reservations and platform prerequisites are checked at execution time.
The platform's `canSubmit` fact is reported separately from policy decisions.

`policy edit` validates the resulting file before saving it. For non-interactive
edits, provide a dotted key and a YAML-typed value. Use `null` to disable an
optional rule:

```bash
olympus policy edit tokens.challenge_budget 100 --json
olympus policy edit tokens.min_remaining_balance 20 --json
```

A rejected operation reports the policy rule and structured details. It does not
start the operation.

`checks.allow_rerun_passing: false` blocks a completed, current (`stale: false`)
PASS check or precheck bundle before paid dispatch. Stale results remain eligible
for rerun; unreadable or ambiguous state is rejected.

`workflow` is accepted as a legacy input alias for `graph`. The canonical output
uses `graph`. Omitted or `null` rules are inactive. Numeric zero is an active
limit. Platform eligibility and request validation remain independent of local
policy.

`policy show --json` normalizes disabled leaves to `null` and reports `source: "missing"` when no file exists. The following is the optional `policy init` template, not runtime defaults; editor schema defaults are suggestions only:

```yaml
# yaml-language-server: $schema=./policy.schema.json
runs:
  max_runs: { nova: 10, vega: 0, orion: 0, castor: 0 } # Maximum current original runs per model
  allow_full_preset: false # Allow the full rollout preset
  allow_manual_batch_name: false # Allow explicit batch names
  allow_cancellations: false # Allow run cancellations
  allow_contests: false # Allow run contests
  re_evaluation:
    enabled: true # Allow re-evaluating existing solutions
    max_attempts: 1 # Maximum attempts per solution set across challenge versions

tokens:
  allow_general_tokens: false # Allow explicit use of general tokens
  min_remaining_balance: null # Minimum reported balance after request cost
  challenge_budget: null # Local per-challenge quoted-token budget; null disables

checks:
  allowed: [
      verifyTests,
      verifySolution,
      verifyFlakiness,
      testQuality,
      taskQuality,
      solutionQuality,
      descriptionQuality,
      autoReview,
      verifierIncompleteness,
    ] # Allowed dynamic checks
  require_explicit_selection: true # Require explicit check selection
  max_checks_per_request: 3 # Maximum distinct checks submitted together
  max_active: 3 # Maximum active dynamic checks per challenge
  allow_rerun_passing: false # Prevent rerunning completed, current PASS checks
  allow_contests: false # Allow check contests

auto_review:
  allow_force_refresh: false # Allow forced reruns of all review dimensions

# The action graph is disabled until explicitly configured.
graph: null
```

### Action graph

`graph` is optional. Set `graph: null` or omit it to disable sequencing. The
available modes are `off`, `advise` and `enforce`. Requirements, transitions and
notes are evaluated only when declared in the policy.

`olympus policy show <challenge-id> --json` includes the current state used for
policy decisions. Platform readiness and technical prerequisites are reported
separately.

Predicates support exactly one operation: `equals`, `empty`, `greater_than`, or
`at_least`. Paths use safe dotted property names. Missing or invalid values do
not satisfy predicates. `start` is optional; without it, no sequence is inferred.
`confirmation` is required in `advise` mode.

Nodes can include an `arguments` mapping for recommended CLI invocations. A
transition with `action: null` ends that branch. Cycles in active transitions are
reported as errors.

Example:
```yaml
graph:
  mode: advise
  start: checks.solutionQuality
  confirmation:
    method: token
    expires_after: 5m
  gates:
    description_ready:
      check: descriptionQuality
      all:
        - { path: status, equals: completed }
        - { path: checkInputs.description.changedSinceCheck, equals: false }
        - { path: output.verdict, equals: PASS }
        - { path: output.evaluation.comments, empty: true }
    tests_ready:
      check: testQuality
      all:
        - { path: status, equals: completed }
        - { path: checkInputs.description.changedSinceCheck, equals: false }
        - { path: checkInputs.tests.changedSinceCheck, equals: false }
        - { path: output.verdict, equals: PASS }
        - { path: output.coverageSummary.fullyCoveredRatio, at_least: 0.8 }
        - { path: output.coverageSummary.untestedGapCount, equals: 0 }
    solution_ready:
      check: solutionQuality
      all:
        - { path: status, equals: completed }
        - { path: checkInputs.description.changedSinceCheck, equals: false }
        - { path: checkInputs.tests.changedSinceCheck, equals: false }
        - { path: checkInputs.solution.changedSinceCheck, equals: false }
        - { path: output.verdict, equals: PASS }
        - { path: output.evaluation.solution_comprehensiveness.score, equals: 3 }
        - { path: output.evaluation.code_quality.score, equals: 3 }
        - { path: output.evaluation.issues, empty: true }
  actions:
    checks.solutionQuality:
      next:
        - action: image.build
          all:
            - { path: checks.solutionQuality.status, equals: completed }
            - {
                path: checks.solutionQuality.checkInputs.description.changedSinceCheck,
                equals: false,
              }
            - { path: checks.solutionQuality.checkInputs.tests.changedSinceCheck, equals: false }
            - { path: checks.solutionQuality.checkInputs.solution.changedSinceCheck, equals: false }
            - { path: checks.solutionQuality.output.verdict, equals: PASS }
    image.build:
      requires: [solution_ready]
      on_unmet: checks.solutionQuality
      next:
        - action: checks.testQuality
          all:
            - { path: image.hasImage, equals: true }
    checks.testQuality:
      requires: [tests_ready]
      on_unmet: checks.testQuality
      next: []
    artifacts.update:
      requires: [description_ready]
      on_unmet: checks.descriptionQuality
      next: []
  notes:
    - id: unfair-tests-local-first
      when:
        check: testQuality
        all:
          - { path: output.verdict, equals: FAIL }
          - { path: output.unfairTestCount, greater_than: 0 }
      severity: warning
      message: Verify locally, correct the tests if needed, then perform at most one rerun.
```

## Environment

| Variable                  | Default                             | Purpose                                                |
| ------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `OLYMPUS_URL`             | `https://shipd.ai/quests/olympus`   | Frontend base URL for authentication and configuration |
| `OLYMPUS_CONVEX_URL`      | fetched from `/api/cli/config`      | Convex deployment override                             |
| `OLYMPUS_API_URL`         | `https://shipd-mars-v2.convex.site` | HTTP API override                                      |
| `OLYMPUS_NO_UPDATE_CHECK` | unset                               | Disable the non-blocking version check                 |
| `OLYMPUS_UPDATE_PACKAGE`  | unset                               | Optional published package used by self-update         |

Credentials are stored at:

```text
~/.shipd/olympus/credentials.json
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run clean
pnpm run build
node dist/index.js --help
```

Source files live under `src/`. Relative source imports use `.ts`; TypeScript rewrites them to `.js` in `dist/`. Generated files under `dist/` are not committed and must not be edited directly.
