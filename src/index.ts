#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import auth from "./commands/auth.ts";
import checks from "./commands/checks.ts";
import problems from "./commands/problems.ts";
import runs from "./commands/runs.ts";
import autoReview from "./commands/auto-review.ts";
import contest from "./commands/contest.ts";
import fpCheck from "./commands/fp-check.ts";
import scopeGate from "./commands/scope-gate.ts";
import verifierAudit from "./commands/verifier-audit.ts";
import { checkVersion, UPDATE_PACKAGE_NAME } from "./config.ts";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const update = defineCommand({
    meta: { name: "update", description: "Update the CLI to the latest version" },
    args: {
        version: { type: "string", description: "Target version (default: latest)" },
    },
    run: async ({ args }) => {
        if (!UPDATE_PACKAGE_NAME) {
            console.error("\n  Self-update is disabled for this private fork.");
            console.error("  Update from your repository and run: pnpm install && pnpm build");
            console.error("  If you publish under your own npm scope, set OLYMPUS_UPDATE_PACKAGE.\n");
            process.exit(1);
        }
        const target = args.version ?? "latest";
        const spec = `${UPDATE_PACKAGE_NAME}@${target}`;
        console.log(`\n  Updating to ${spec}...`);
        try {
            execFileSync("npm", ["install", "-g", spec], { stdio: "inherit" });
            console.log(`\n  Updated successfully.`);
        }
        catch {
            console.error(`\n  Update failed. Try manually: npm install -g ${spec}`);
            process.exit(1);
        }
    },
});
const main = defineCommand({
    meta: {
        name: "olympus",
        version,
        description: "Olympus CLI — Gustavo's Fork",
    },
    subCommands: {
        auth,
        problems,
        checks,
        "scope-gate": scopeGate,
        "fp-check": fpCheck,
        "verifier-audit": verifierAudit,
        "auto-review": autoReview,
        contest,
        runs,
        update,
        view: defineCommand({
            meta: { name: "view", description: "Shortcut for `olympus problems view <id>`" },
            args: {
                id: { type: "positional", description: "Problem ID", required: true },
                json: { type: "boolean", description: "Output as JSON" },
            },
            run: async (ctx) => {
                const sub = (problems.subCommands as any)?.view;
                if (!sub) {
                    throw new Error("Problems view command is unavailable.");
                }
                await sub.run?.(ctx);
            },
        }),
    },
});
// Non-blocking min version check
void checkVersion();
runMain(main);
