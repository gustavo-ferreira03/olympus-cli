import {
  defineCommand,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
  type Resolvable,
  type SubCommandsDef,
} from "citty";
import { printJson } from "../terminal/format.ts";
import { CliError } from "../shared/errors.ts";
import { CHECK_INPUTS_RESULT_SCHEMA } from "../core/check-inputs.ts";
import { COVERAGE_RESULT_SCHEMA } from "../core/coverage.ts";
import { policyActionCatalog } from "../core/action-catalog.ts";
import { policySchema } from "../core/policy.ts";

type CommandSchema = {
  path: string[];
  meta?: CommandMeta;
  default?: string;
  args: ArgsDef;
  flags: string[];
  subCommands: string[];
  resultSchemas?: Record<string, unknown>;
  policyAuthoring?: Record<string, unknown>;
};

function policyAuthoringContract(): Record<string, unknown> {
  return {
    kind: "olympus.policy",
    format: "yaml",
    canonicalFile: "~/.shipd/olympus/policy.yml",
    canonicalRootKeys: ["runs", "tokens", "checks", "auto_review", "graph"],
    schema: policySchema(),
    actionCatalog: policyActionCatalog(),
    predicateOperators: {
      equals: "Exact scalar equality; no coercion",
      empty: "Empty string or empty array/object",
      greater_than: "Strict numeric comparison (>)",
      at_least: "Inclusive numeric comparison (>=)",
    },
    semantics: {
      omittedOrNull: "The rule is inactive; no value is inferred",
      zero: "An explicit numeric zero is an active limit",
      graph:
        "Only declared actions, gates, requirements and transitions exist; omitted edges are not inferred",
      requirements: "Block or advise an action when declared predicates are unmet",
      notes: "Informational guidance only; notes never trigger work",
      unknownState: "Missing or malformed facts never satisfy a predicate",
      aliases: "workflow is accepted only as a legacy input alias for graph; never emit both",
    },
    authoringProtocol: [
      "Read this contract and choose only catalog actions.",
      "Write YAML using the returned JSON Schema; use graph: null unless sequencing is intentional.",
      "Use policy show --json for current configuration, then policy show <challenge-id> --json for state-aware decisions.",
      "Keep requirements in gates/actions and guidance in notes; never encode a hidden default order.",
      "Re-read the effective policy after saving; inspection is not execution permission.",
    ],
    examples: {
      leastPrivilege: [
        "checks:",
        "  require_explicit_selection: true",
        "  allow_rerun_passing: false",
        "tokens:",
        "  allow_general_tokens: false",
        "graph: null",
      ].join("\n"),
      oneGate: [
        "graph:",
        "  mode: enforce",
        "  start: checks.verifySolution",
        "  gates:",
        "    solution_ready:",
        "      check: solutionQuality",
        "      all:",
        "        - { path: status, equals: completed }",
        "        - { path: output.verdict, equals: PASS }",
        "  actions:",
        "    checks.verifySolution:",
        "      requires: [solution_ready]",
        "      on_unmet: checks.solutionQuality",
        "      next: []",
        "  notes: []",
      ].join("\n"),
    },
  };
}

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

async function describe(
  command: CommandDef,
  path: string[],
  children: SubCommandsDef,
): Promise<CommandSchema> {
  const args = await resolve(command.args ?? {});
  return {
    path,
    ...(command.meta === undefined ? {} : { meta: await resolve(command.meta) }),
    ...(command.default === undefined ? {} : { default: await resolve(command.default) }),
    args,
    flags: Object.entries(args)
      .filter(([, arg]) => arg.type !== "positional")
      .map(([name]) => `--${name}`),
    subCommands: Object.keys(children),
    ...(path.length === 2 && path[1] === "policy"
      ? { policyAuthoring: policyAuthoringContract() }
      : {}),
    ...(["policy", "checks"].some((name) => path.includes(name))
      ? {
          resultSchemas: {
            checkInputsResult: CHECK_INPUTS_RESULT_SCHEMA,
            testQualityCoverage: COVERAGE_RESULT_SCHEMA,
          },
        }
      : {}),
  };
}

async function collect(
  command: CommandDef,
  path: string[],
  ancestors = new Set<CommandDef>(),
): Promise<CommandSchema[]> {
  if (ancestors.has(command)) {
    throw new Error(`Circular command tree at: ${path.join(" ")}`);
  }
  const children = await resolve(command.subCommands ?? {});
  const commands = [await describe(command, path, children)];
  const nextAncestors = new Set(ancestors).add(command);
  for (const [name, child] of Object.entries(children)) {
    commands.push(...(await collect(await resolve(child), [...path, name], nextAncestors)));
  }
  return commands;
}

async function findChild(
  children: SubCommandsDef,
  name: string,
): Promise<[string, CommandDef] | undefined> {
  if (Object.hasOwn(children, name)) {
    return [name, await resolve(children[name])];
  }
  for (const [key, child] of Object.entries(children)) {
    const command = await resolve(child);
    const meta = await resolve(command.meta ?? {});
    const aliases = typeof meta.alias === "string" ? [meta.alias] : (meta.alias ?? []);
    if (aliases.includes(name)) return [key, command];
  }
  return undefined;
}

export function createSchemaCommand(root: CommandDef): CommandDef {
  return defineCommand<ArgsDef>({
    meta: {
      name: "schema",
      description:
        "Print declared command metadata as JSON; optionally select a space-separated command path",
    },
    args: {
      command: {
        type: "positional",
        required: false,
        description: "Command path segments, such as runs run; omit to list the full command tree",
      },
      json: {
        type: "boolean",
        description: "Output as JSON (schema always emits JSON)",
      },
    },
    run: async ({ args }) => {
      const segments = args._;
      const rootMeta = await resolve(root.meta ?? {});
      const path = rootMeta.name ? [rootMeta.name] : [];
      if (segments.length === 0) {
        printJson({
          commands: await collect(root, path),
          policyAuthoring: policyAuthoringContract(),
          resultSchemas: {
            checkInputsResult: CHECK_INPUTS_RESULT_SCHEMA,
            testQualityCoverage: COVERAGE_RESULT_SCHEMA,
          },
        });
        return;
      }
      let command = root;
      for (const segment of segments) {
        const children = await resolve(command.subCommands ?? {});
        const found = await findChild(children, segment);
        if (!found) {
          throw new CliError(`Unknown command path: ${[...path, segment].join(" ")}`, {
            kind: "usage",
            code: "schema.unknown_command",
            retryable: false,
            hint: "Run olympus schema to discover available command paths.",
          });
        }
        path.push(found[0]);
        command = found[1];
      }
      printJson(await describe(command, path, await resolve(command.subCommands ?? {})));
    },
  });
}
