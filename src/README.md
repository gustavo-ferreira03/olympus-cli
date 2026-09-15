# Source layout

Dependencies point inward. A layer may import from the layers below it in this
list, never from the ones above.

| Directory    | Holds                                                        | May import                               |
| ------------ | ------------------------------------------------------------ | ---------------------------------------- |
| `commands/`  | One module per CLI command; citty definitions and their glue | anything except another command          |
| `dashboard/` | The live dashboard: `data` (snapshot → rows), `ui`, `tui`    | `core`, `platform`, `terminal`, `shared` |
| `core/`      | Domain rules: policy, budget, pricing, checks, artifacts     | `platform`, `terminal`, `shared`         |
| `platform/`  | The outside world: auth, config, Convex client               | `core`, `shared`                         |
| `terminal/`  | Rendering and process IO: tables, JSON, diagnostics          | `shared`                                 |
| `shared/`    | Leaf utilities and cross-layer types                         | nothing internal                         |

`index.ts` is the composition root and may reach anywhere.

## What the linter enforces

`.oxlintrc.json` pins the two ends that matter and leaves the middle to
judgement:

- **`shared/` stays a leaf** (error). A helper that needs domain knowledge
  belongs in `core/` instead.
- **Commands stay leaves** (warning). When two commands need the same thing, it
  moves down a layer — that is how `shared/wait.ts`, `core/check-wait.ts` and
  `core/artifacts.ts` came to exist.
- **Nothing below `commands/` imports from it** (error).
- **`import/no-cycle`** is an error everywhere; it is the real backstop.

The `core` ↔ `platform` and `core` → `terminal` edges are deliberately not
policed: `platform/convex.ts` installs the policy guards, and `core/policy.ts`
reports budget feedback to the terminal. Both are conscious trade-offs rather
than accidents.

## Complexity and size budgets

`complexity`, `max-depth`, `max-lines`, `max-lines-per-function`, `no-shadow`
and the nested-ternary rules are **warnings**, and `pnpm lint:ci` pins the total
count. Debt can shrink but never grow: new code comes in under budget, and
touching an over-budget function means paying some of it down. Everything
outside that set is an error and fails the build.

When the count drops, lower `--max-warnings` in `package.json` to match.
