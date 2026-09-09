import { defineCommand } from "citty";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { dirname, resolve } from "node:path";
import {
  defaultPolicyYaml,
  loadPolicy,
  parsePolicy,
  policyPath,
  policySchema,
} from "../core/policy.ts";
import { printJson } from "../terminal/format.ts";

const show = defineCommand({
  meta: { name: "policy show", description: "Validate and show the effective local guardrails" },
  args: { json: { type: "boolean", description: "Output compact JSON" } },
  run: ({ args }) => {
    const path = policyPath();
    const policy = loadPolicy();
    const result = { path, source: existsSync(path) ? "file" : "missing", policy };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const init = defineCommand({
  meta: {
    name: "policy init",
    description: "Create a commented policy file without overwriting an existing one",
  },
  args: {
    json: { type: "boolean", description: "Output compact JSON" },
    "schema-only": {
      type: "boolean",
      description: "Refresh editor schema without changing policy values",
    },
  },
  run: ({ args }) => {
    const path = policyPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && !args["schema-only"])
      throw new Error(`Guardrails file already exists: ${path}`);
    writeFileSync(
      resolve(dirname(path), "policy.schema.json"),
      `${JSON.stringify(policySchema(), null, 2)}\n`,
      { mode: 0o600 },
    );
    if (args["schema-only"]) {
      const schemaPath = resolve(dirname(path), "policy.schema.json");
      if (args.json) return printJson({ status: "schema-updated", path: schemaPath });
      console.log(`Updated ${schemaPath}; policy values unchanged`);
      return;
    }
    writeFileSync(path, defaultPolicyYaml, { flag: "wx", mode: 0o600 });
    if (args.json) return printJson({ status: "created", path });
    console.log(`Created ${path}`);
  },
});

const edit = defineCommand({
  meta: { name: "policy edit", description: "Edit guardrails in your editor" },
  args: {
    key: {
      type: "positional",
      description: "Optional dotted key, such as tokens.challenge_budget",
      required: false,
    },
    value: {
      type: "positional",
      description: "New YAML value, such as 100, false, null or '[verifyTests]'",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Output JSON; requires key and value (no interactive editor)",
    },
  },
  run: ({ args }) => {
    const direct = args.key !== undefined;
    if (direct !== (args.value !== undefined))
      throw new Error("Provide both a policy key and a YAML value, or neither to open the editor");
    if (direct && !args.value!.trim())
      throw new Error("Provide an explicit YAML value; use null to disable an optional rule");
    if (!direct && args.json) throw new Error("JSON mode requires a policy key and a YAML value");
    const editor =
      process.env.VISUAL?.trim()
      || process.env.EDITOR?.trim()
      || (process.stdin.isTTY ? "vi" : undefined);
    if (!direct && !editor)
      throw new Error("Set VISUAL or EDITOR, or use policy edit <key> <value>");
    const path = policyPath();
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFd = openSync(
      resolve(directory, ".policy-edit.flock"),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const draft = resolve(directory, `.policy-edit-${randomUUID()}.yml`);
    try {
      const acquired = spawnSync("flock", ["-n", "3"], {
        stdio: ["ignore", "ignore", "pipe", lockFd],
      });
      if (acquired.error || (acquired.status !== 0 && acquired.status !== 1))
        throw new Error(
          "Cannot acquire the edit lock; policy edit requires working flock (util-linux)",
        );
      if (acquired.status === 1)
        throw new Error("Another policy edit is in progress; close that editor before retrying");
      if (existsSync(path) && !lstatSync(path).isFile())
        throw new Error("Policy path must be a regular file");
      const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      let text = original ?? "# yaml-language-server: $schema=./policy.schema.json\n{}\n";
      if (direct) {
        const keys = args.key!.split(".");
        if (
          keys.some(
            (key) =>
              !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)
              || ["__proto__", "prototype", "constructor"].includes(key),
          )
        )
          throw new Error("Invalid dotted policy key");
        const doc = parseDocument(text, { uniqueKeys: true, merge: false });
        const value = parseDocument(args.value!, { uniqueKeys: true, merge: false });
        if (
          doc.errors.length > 0
          || doc.warnings.length > 0
          || value.errors.length > 0
          || value.warnings.length > 0
          || value.contents === null
        )
          throw new Error("Invalid or empty YAML value; policy unchanged");
        doc.toJS({ maxAliasCount: 0 });
        doc.setIn(keys, value.toJS({ maxAliasCount: 0 }));
        text = doc.toString();
      }
      writeFileSync(draft, text, { flag: "wx", mode: 0o600 });
      if (!direct) {
        writeFileSync(
          resolve(directory, "policy.schema.json"),
          `${JSON.stringify(policySchema(), null, 2)}\n`,
          { mode: 0o600 },
        );
        const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "policy-editor", draft], {
          stdio: "inherit",
        });
        if (result.error || result.status !== 0)
          throw new Error("Editor failed or was interrupted; policy unchanged");
        text = readFileSync(draft, "utf8");
      }
      const policy = parsePolicy(text);
      const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (current !== original)
        throw new Error("Policy changed while editing; refusing to overwrite concurrent changes");
      writeFileSync(
        resolve(directory, "policy.schema.json"),
        `${JSON.stringify(policySchema(), null, 2)}\n`,
        { mode: 0o600 },
      );
      const changed = text !== original;
      if (changed) renameSync(draft, path);
      const result = { status: changed ? "updated" : "unchanged", path, policy };
      if (args.json) return printJson(result);
      console.log(`${changed ? "Updated" : "Validated"} ${path}`);
    } finally {
      try {
        if (existsSync(draft)) unlinkSync(draft);
      } finally {
        closeSync(lockFd);
      }
    }
  },
});

export default defineCommand({
  meta: { name: "policy", description: "Configure local guardrails" },
  subCommands: { show, init, edit },
});
