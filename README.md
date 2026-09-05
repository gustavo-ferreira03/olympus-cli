# Olympus CLI — Gustavo's Fork

A maintained TypeScript CLI for Project Olympus on Shipd.

Use it to inspect and edit challenges, run prechecks and quality checks, manage Docker-backed verification, review rollouts, handle later-stage audits, and automate long-running operations without external polling scripts.

## Install from source

```bash
git clone https://github.com/gustavo-ferreira03/olympus-cli.git
cd olympus-cli
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
```

Verify the active CLI:

```bash
command -v olympus
olympus --version
olympus --help
```

The banner should identify `Olympus CLI — Gustavo's Fork`.

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
```

Run `olympus <command> --help` for the exact arguments accepted by a command.

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

Request the complete backend payload only when necessary:

```bash
olympus problems view <challenge-id> --json --full
```

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
- expected failures return `{ "status": "error", "error": "..." }` with a non-zero exit code;
- empty waits return `status: "idle"` instead of historical payloads;
- null and empty fields are removed from compact responses;
- large raw payloads require `--full`;
- paginated responses include `nextCommand` when more data exists;
- transient connection failures are retried automatically.

This removes the need for ad-hoc `sleep`, polling loops, `jq`, grep, head, or tail in normal agent workflows.

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

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `OLYMPUS_URL` | `https://shipd.ai/quests/olympus` | Frontend base URL for authentication and configuration |
| `OLYMPUS_CONVEX_URL` | fetched from `/api/cli/config` | Convex deployment override |
| `OLYMPUS_API_URL` | `https://shipd-mars-v2.convex.site` | HTTP API override |
| `OLYMPUS_NO_UPDATE_CHECK` | unset | Disable the non-blocking version check |
| `OLYMPUS_UPDATE_PACKAGE` | unset | Optional published package used by self-update |

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
