# Olympus CLI _(Gustavo's Fork)_

A maintained TypeScript CLI for Project Olympus on Shipd, based on the [@shipd-ai/olympus-cli npm package](https://www.npmjs.com/package/@shipd-ai/olympus-cli).

Use it to inspect and edit challenges, run prechecks and quality checks, manage Docker-backed verification, review rollouts, handle later-stage audits, and automate long-running operations without external polling scripts.

## Contents

- [Installation](#installation)
- [Get started](#get-started)
- [Command overview](#command-overview)
- [Inspect a challenge](#inspect-a-challenge)
- [Prerequisites](#prerequisites)
- [Live terminal dashboard](#live-terminal-dashboard)
- [Build the version image](#build-the-version-image)
- [Prechecks and quality checks](#prechecks-and-quality-checks)
- [Scope Gate and later-stage reviews](#scope-gate-and-later-stage-reviews)
- [Rollouts](#rollouts)
- [Artifact output without external tools](#artifact-output-without-external-tools)
- [JSON behavior](#json-behavior)
- [Download a challenge locally](#download-a-challenge-locally)
- [Create, edit, and version drafts](#create-edit-and-version-drafts)
- [Policy](#policy)
  - [Action graph](#action-graph)
- [Environment](#environment)
- [Update](#update)

## Installation

Requires Node.js 20 or newer and pnpm. The CLI is installed from source. `policy edit` also requires `flock` (util-linux), so run that command on Linux or WSL.

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

The JSON form is compact and includes follow-up commands for more detail.

## Command overview

```text
olympus auth             Authentication
olympus problems         Challenge metadata, artifacts, versions, and submission
olympus checks           Prechecks, quality checks, findings, and readiness
olympus image            Version image build, status, waiting, and cancellation
olympus scope-gate       Scope Gate inspection and execution
olympus delivery-verification  Delivery verification state
olympus fp-check         False-positive check inspection and execution
olympus verifier-audit   Verifier Completeness Audit and decisions
olympus auto-review      Auto Review inspection and execution
olympus contest          Quality-check contests
olympus runs             Rollout batches, runs, artifacts, and re-evaluation
olympus tokens           Token balance, usage history, progression, and challenge costs
olympus prestige         Prestige ELO outlook, leaderboard, and category boosts
olympus policy           Policy rules and optional action graph
olympus dependencies     What a challenge still needs before an action can run
olympus dashboard        Live read-only terminal dashboard
olympus bot              Chat with Shipd Bot about a challenge
olympus schema           JSON description of every command
olympus view <id>        Shortcut for `olympus problems view <id>`
```

Run `olympus <command> --help` for the arguments a command accepts. `olympus schema`
prints the whole command tree as JSON; `olympus schema runs run` prints one command.

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

## Prerequisites

Check what a challenge still needs before an action can run, without starting anything:

```bash
olympus dependencies catalog --json
olympus dependencies view <challenge-id> --json
olympus dependencies view <challenge-id> --action=checks.verifySolution --json
olympus dependencies view <challenge-id> --action=checks.run_all --checks=verifyTests,verifyFlakiness --json
```

Commands that start work run the same check first. When something is missing they stop
with `dependencies.blocked`, listing each unmet requirement and a command to inspect or
fix it. Nothing is run on your behalf, and the platform can still reject a request.

## Live terminal dashboard

```bash
olympus dashboard                      # account overview; choose a challenge
olympus dashboard <challenge-id>       # open one challenge directly
olympus dashboard <challenge-id> --interval=5
olympus dashboard <challenge-id> --json
olympus dashboard --json               # one overview snapshot
```

Without an ID, the dashboard opens the home view, laid out like the platform's home:

- **Tokens**: balance and cap, revision tickets, tier, drip rate and next drip, accepted
  bonus, approval rate for the current window (accepted, rejected, total), lifetime
  accepted and the next tier, followed by the accepted timeline (markers per lane, what
  aged out) and, on tall terminals, the latest Token History entries.
- **Prestige**: Elo, the estimate at rotation and when it rotates, distance to Prestige
  and the seat cut, active Elo boosts, and the token usage chart (6h bins, cumulative
  usage and accepted markers).
- **Changes Requested**: challenges a reviewer sent back, with the feedback.
- **My Challenges**: your challenges with the platform's status tabs (All, Draft, Pending
  Review, Revision Needed, Finalizing Review, Accepted, Rejected) and its columns.

The charts shrink to one-line summaries, then to just the figures, when the terminal is
too short to show them along with at least five challenges. Use Left/Right to switch the status tab, Up/Down (or PgUp/PgDn) to select a challenge
and Enter to open its live monitor. Press `b` or Escape in the monitor to return home;
`q` exits. Archived challenges are hidden unless you pass `--include-archived`;
`--status`, `--language`, `--difficulty` and `--category` filter the list
(case-insensitive; `all` clears a filter).

The monitor groups the challenge the way the platform does: each precheck stage
(GitHub Repository, Problem Description & Tests, Plagiarism Review, Dockerfile, Solution
Patch), Build & Scope (image, Scope Gate), Quality Checks, Audits (Verifier Completeness Audit,
Rollout Coach), Auto Review, FP Check, and Rollouts. The header shows the status, version, submission
type and precheck/rollout counts, plus a warning when delivery verification failed.

Updates arrive live as soon as anything changes on the platform. Press `r` to reconnect
and reload everything.

In the monitor, Tab moves between sections, the arrows select a tile, Enter opens its
details and `h` toggles rollout history. Small terminals get denser tiles; when the
content does not fit, the view pages automatically every six seconds (keyboard input
pauses it).

Colors are emitted only in a TTY; set `NO_COLOR` to disable them.

The account telemetry is also available without opening the TUI:

```bash
olympus tokens balance --json
olympus tokens usage --json
olympus tokens usage --json --from 2026-09-14 --to 2026-09-15
olympus tokens progression --json
olympus prestige outlook --exact --json
olympus prestige leaderboard --json
olympus prestige boosts --json
```

`tokens balance` shows your tier, cap, drip, accepted counts in the current window and
lifetime, what the next tier requires, and any comeback offer. `tokens usage` shows
grants and spending for a period; the platform keeps only the 50 most recent entries,
so the output warns when `--from` reaches further back than that.

`prestige outlook --exact` computes your ELO precisely (slower).

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
olympus checks run-prechecks <challenge-id> --use-general-tokens --json
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

Run all quality checks:

```bash
olympus checks run-all <challenge-id> --wait --json
```

Check keys and the names the platform shows for them:

| Key                      | Platform name               |
| ------------------------ | --------------------------- |
| `verifyTests`            | Verify Tests                |
| `verifySolution`         | Verify Solution             |
| `verifyFlakiness`        | Verify Flakiness            |
| `testQuality`            | Test Quality                |
| `taskQuality`            | Task Quality                |
| `solutionQuality`        | Solution Quality            |
| `descriptionQuality`     | Task Prompt Quality         |
| `rolloutCoach`           | Rollout Coach               |
| `autoReview`             | Auto Review                 |
| `verifierIncompleteness` | Verifier Completeness Audit |

Use these keys in commands and policy files. `run-all` runs the first seven; Rollout
Coach runs on its own, and Auto Review and the Verifier Completeness Audit use the
`auto-review` and `verifier-audit` commands.

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

Delivery verification:

```bash
olympus delivery-verification view <challenge-id> --json
```

Shows the verification that runs after submitting: status, progress, current step and
any failure.

False-positive check:

```bash
olympus fp-check view <challenge-id> --json
olympus fp-check run <challenge-id> --json
olympus fp-check wait <challenge-id> --json
olympus fp-check contest <challenge-id> --note="<reason>" --json
olympus fp-check keep-paths <challenge-id> --json
olympus fp-check keep-paths <challenge-id> --set=src/,lib/ --json
olympus fp-check keep-paths <challenge-id> --clear --json
```

When the FP check flags a false positive, `fp-check wait` exits non-zero and reports
`verdict: "false_positive"`. `contest` works only while the platform allows contesting
that result. `keep-paths` protects up to 10 repository folders from the next FP check.

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
olympus contest task-prompt <challenge-id> --json
olympus contest test-quality <challenge-id> --note="<reason>" --json
olympus contest solution <challenge-id> --note="<reason>" --json
olympus contest category <challenge-id> --note="<reason>" --json
olympus contest task-as-mars <challenge-id> --json
```

`contest category` contests a failed `category_alignment` precheck.

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

## JSON behavior

Machine-readable commands follow these rules:

- stdout contains exactly one JSON document;
- polling progress is suppressed in JSON mode;
- errors include `error`, `kind`, `code`, `retryable` and `hint` (plus the policy `rule` when a policy blocked the command);
- empty waits return `status: "idle"` instead of historical payloads;
- null and empty fields are removed from compact responses;
- large raw payloads require `--full`;
- paginated responses include `nextCommand` when more data exists;
- wait commands retry transient connection failures while polling.

Error kinds are `usage`, `auth`, `permission`, `not_found`, `rate_limit`, `network`,
`config`, `policy`, `budget` and `unknown`. Inspect a transient error before retrying a
request that costs tokens.

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
olympus problems create --diamond --json
olympus problems mine --archived --json
olympus problems archive <challenge-id> --json
olympus problems unarchive <challenge-id> --json
olympus problems type <challenge-id> --json
olympus problems type <challenge-id> mars --json
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
olympus problems submit <challenge-id> --skip-human-review --json
olympus problems submit <challenge-id> --type=mars --include-coauthorship --json
```

`problems create --diamond` creates a Diamond draft. `problems type` shows which
submission types are available to you and changes it; switching away from a type that
already has a Task Quality result needs `--yes`. `problems mine` hides archived
challenges unless `--archived` is passed.

On submit, `--type` picks the lane (`olympus` or `mars`; Diamond always uses
`olympus`), `--include-coauthorship` includes your coauthors, and
`--skip-human-review` asks to skip human review when you are eligible. If the response
says verification started, the challenge is submitted automatically once it passes.

## Policy

A policy is a local file that limits what the CLI may do on your behalf: which checks
and models it can run, token limits, and optionally the order of steps. It is checked
every time a command runs.

`policy show` displays the rules; `--full` expands them. With a challenge ID it also
shows what currently blocks or is suggested for that challenge.

```bash
olympus policy show                        # human rules and graph, no API calls
olympus policy show --full                 # expanded human policy definitions
olympus policy show <challenge-id>         # current blockers and suggestions
olympus policy guide <challenge-id> --json  # focused workflow guidance
olympus policy show --json                 # effective configuration, no API calls
olympus policy show <challenge-id> --json  # configuration plus state-aware decisions
olympus policy show <challenge-id> --full --json  # also include canonical state
```

`policy guide` tells you the next step. It returns `guidance.status`, the expected
action and the exact `nextCommand`. Run `nextCommand` only when the status is `ready`;
`blocked` means there is nothing safe to run yet. After any change, run the returned
`refreshCommand` before choosing the next step.

To write a policy, start from the schema and examples:

```bash
olympus schema policy --json                # policy schema, action catalog and examples
olympus schema --json                       # same contract plus the full CLI schema
olympus policy init --json                  # optional human/editor starter
olympus policy edit <key> <yaml-value> --json  # typed single-key update
```

`olympus schema policy` lists every field, the actions a policy can govern with their
commands and arguments, and YAML examples. Keep `graph: null` unless you want to
enforce an order of steps.

`policy edit` validates the file before saving. Give a dotted key and a YAML value;
`null` disables a rule:

```bash
olympus policy edit tokens.challenge_budget 100 --json
olympus policy edit tokens.min_remaining_balance 20 --json
```

When a policy blocks a command, it reports the rule and does not start anything.
Omitted or `null` rules are inactive; `0` is an active limit.
`checks.allow_rerun_passing: false` stops you from rerunning a check that already
passed for the current inputs.

`olympus policy init` writes this starter file (it is not applied until you create it):

```yaml
# yaml-language-server: $schema=./policy.schema.json
runs:
  max_runs: { nova: 10, vega: 0, orion: 0, castor: 0 } # Maximum current runs per model, re-evaluated included
  allow_full_preset: false # Allow the full rollout preset
  allow_manual_batch_name: false # Allow explicit batch names
  allow_cancellations: false # Allow run cancellations
  allow_contests: false # Allow run contests
  re_evaluation:
    enabled: true # Allow re-evaluating existing solutions
    max_attempts: 1 # Maximum attempts per solution set across challenge versions
    block_new_runs_when_available: false # Block new rollout runs while re-evaluation is available

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

`graph` is optional and defines the order of steps. Modes are `off`, `advise` (asks
for confirmation before stepping off the graph) and `enforce`. `olympus policy show
<challenge-id> --json` shows the state the graph is evaluated against.

Each predicate uses one operator: `equals`, `empty`, `greater_than` or `at_least`; a
missing value never matches. Nodes can include `arguments` for the suggested command,
and a transition with `action: null` ends that branch.

Example:

```yaml
graph:
  mode: advise

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

| Variable                  | Default                             | Purpose                                         |
| ------------------------- | ----------------------------------- | ----------------------------------------------- |
| `OLYMPUS_URL`             | `https://shipd.ai/quests/olympus`   | Platform URL used for sign-in and configuration |
| `OLYMPUS_CONVEX_URL`      | fetched from the platform           | Backend override                                |
| `OLYMPUS_API_URL`         | `https://shipd-mars-v2.convex.site` | HTTP API override                               |
| `OLYMPUS_NO_UPDATE_CHECK` | unset                               | Disable the version check                       |
| `OLYMPUS_UPDATE_PACKAGE`  | unset                               | Package used by `olympus update`                |

Credentials are stored at:

```text
~/.shipd/olympus/credentials.json
```

## Update

```bash
git pull
pnpm install --frozen-lockfile
pnpm run build
```
