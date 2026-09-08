import {
  defineCommand,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
  type Resolvable,
  type SubCommandsDef,
} from "citty";
import { printJson } from "./format.ts";
import { CliError } from "./errors.ts";

type CommandSchema = {
  path: string[];
  meta?: CommandMeta;
  default?: string;
  args: ArgsDef;
  flags: string[];
  subCommands: string[];
};

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : await value;
}

async function describe(
  command: CommandDef,
  path: string[],
  children: SubCommandsDef,
): Promise<CommandSchema> {
  const args = await resolve(command.args ?? {});
  return {
    path,
    ...(command.meta === undefined
      ? {}
      : { meta: await resolve(command.meta) }),
    ...(command.default === undefined
      ? {}
      : { default: await resolve(command.default) }),
    args,
    flags: Object.entries(args)
      .filter(([, arg]) => arg.type !== "positional")
      .map(([name]) => `--${name}`),
    subCommands: Object.keys(children),
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
    commands.push(
      ...(await collect(await resolve(child), [...path, name], nextAncestors)),
    );
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
    const aliases =
      typeof meta.alias === "string" ? [meta.alias] : (meta.alias ?? []);
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
        description:
          "Command path segments, such as runs run; omit to list the full command tree",
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
        printJson({ commands: await collect(root, path) });
        return;
      }
      let command = root;
      for (const segment of segments) {
        const children = await resolve(command.subCommands ?? {});
        const found = await findChild(children, segment);
        if (!found) {
          throw new CliError(
            `Unknown command path: ${[...path, segment].join(" ")}`,
            {
              kind: "usage",
              code: "schema.unknown_command",
              retryable: false,
              hint: "Run olympus schema to discover available command paths.",
            },
          );
        }
        path.push(found[0]);
        command = found[1];
      }
      printJson(
        await describe(command, path, await resolve(command.subCommands ?? {})),
      );
    },
  });
}
