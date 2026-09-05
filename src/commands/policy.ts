import { defineCommand } from "citty";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { defaultPolicyYaml, loadPolicy, policyPath } from "../policy.ts";
import { printJson } from "../format.ts";

const show = defineCommand({
  meta: { name: "policy show", description: "Validate and show the effective local spending policy" },
  args: { json: { type: "boolean", description: "Output compact JSON" } },
  run: ({ args }) => {
    const path = policyPath();
    const policy = loadPolicy();
    const result = { path, source: existsSync(path) ? "file" : "defaults", policy };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const init = defineCommand({
  meta: { name: "policy init", description: "Create a commented policy file without overwriting an existing one" },
  args: { json: { type: "boolean", description: "Output compact JSON" } },
  run: ({ args }) => {
    const path = policyPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, defaultPolicyYaml, { flag: "wx", mode: 0o600 });
    if (args.json) return printJson({ status: "created", path });
    console.log(`Created ${path}`);
  },
});

export default defineCommand({
  meta: { name: "policy", description: "Configure local rollout and spending guardrails" },
  subCommands: { show, init },
});
