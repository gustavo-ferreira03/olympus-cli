#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineCommand, runCommand, runMain, showUsage } from "citty";
import auth from "./commands/auth.ts";
import checks from "./commands/checks.ts";
import problems from "./commands/problems.ts";
import runs from "./commands/runs.ts";
import autoReview from "./commands/auto-review.ts";
import contest from "./commands/contest.ts";
import fpCheck from "./commands/fp-check.ts";
import image from "./commands/image.ts";
import scopeGate from "./commands/scope-gate.ts";
import verifierAudit from "./commands/verifier-audit.ts";
import tokens from "./commands/tokens.ts";
import policy from "./commands/policy.ts";
import dashboard from "./commands/dashboard.ts";
import { PolicyError } from "./policy.ts";
import { BudgetError } from "./budget.ts";
import { printJson } from "./format.ts";
import { checkVersion, UPDATE_PACKAGE_NAME } from "./config.ts";
import { CliError, describeError, sanitizeDiagnostic } from "./errors.ts";
import { installDiagnosticOutput } from "./diagnostics.ts";
import { createSchemaCommand } from "./schema.ts";
installDiagnosticOutput();
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const update = defineCommand({
    meta: { name: "update", description: "Update the CLI to the latest version" },
    args: {
        version: { type: "string", description: "Target version (default: latest)" },
        json: { type: "boolean", description: "Output JSON" },
    },
    run: async ({ args }) => {
        if (!UPDATE_PACKAGE_NAME) {
            throw new CliError("Self-update is disabled for this private fork.", { kind: "config", code: "update.disabled", retryable: false, hint: "Update from your repository and run pnpm install && pnpm build, or configure OLYMPUS_UPDATE_PACKAGE for your published fork." });
        }
        const target = args.version ?? "latest";
        const spec = `${UPDATE_PACKAGE_NAME}@${target}`;
        if (!args.json) console.log(`\n  Updating to ${spec}...`);
        try {
            execFileSync("npm", ["install", "-g", spec], { stdio: args.json ? "pipe" : "inherit" });
            if (args.json) printJson({ status: "updated", package: UPDATE_PACKAGE_NAME, version: target });
            else console.log(`\n  Updated successfully.`);
        }
        catch {
            throw new CliError("Update failed.", { kind: "unknown", code: "update.failed", retryable: null, hint: `Inspect the npm failure before retrying npm install -g ${spec}.` });
        }
    },
});
const main = defineCommand({
    meta: {
        name: "olympus",
        version,
        description: "Olympus CLI — Gustavo's Fork",
    },
    default: "help",
    subCommands: {
        auth,
        problems,
        checks,
        image,
        "scope-gate": scopeGate,
        "fp-check": fpCheck,
        "verifier-audit": verifierAudit,
        "auto-review": autoReview,
        contest,
        runs,
        tokens,
        policy,
        dashboard,
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
        help: defineCommand({
            meta: { name: "help", description: "Show the main command overview" },
            run: async () => {
                await showUsage(main);
            },
        }),
    },
});
Object.assign(main.subCommands!, { schema: createSchemaCommand(main) });
function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && "data" in error) {
        const data = (error as { data?: unknown }).data;
        if (typeof data === "string" && data.trim()) return data.trim();
    }
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return String(error);
}

const rawArgs = process.argv.slice(2);
const jsonOutput = rawArgs.includes("--json") || rawArgs[0] === "schema";
const usesBuiltinOutput = rawArgs.some((arg) => arg === "--help" || arg === "-h") ||
    (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v"));

if (usesBuiltinOutput) {
    await runMain(main, { rawArgs });
}
else {
    const versionCheck = new AbortController();
    let versionCheckTimeout: ReturnType<typeof setTimeout> | undefined;
    const versionCheckStart = setImmediate(() => {
        if (jsonOutput || rawArgs[0] === "dashboard") return;
        versionCheckTimeout = setTimeout(() => versionCheck.abort(), 2000);
        versionCheckTimeout.unref();
        void checkVersion(versionCheck.signal);
    });
    versionCheckStart.unref();
    try {
        await runCommand(main, { rawArgs });
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "E_NO_COMMAND") {
            await runMain(main, { rawArgs: [...rawArgs, "--help"] });
        }
        else {
            const message = errorMessage(error);
            if (jsonOutput) {
                printJson({ ...(error instanceof PolicyError || error instanceof BudgetError
                    ? { status: "blocked", rule: sanitizeDiagnostic(error.rule), ...error.details }
                    : { status: "error" }), error: sanitizeDiagnostic(message), ...describeError(error) });
            }
            else {
                console.error(`Error: ${message}`);
            }
            process.exitCode = 1;
        }
    }
    finally {
        clearImmediate(versionCheckStart);
        clearTimeout(versionCheckTimeout);
        versionCheck.abort();
    }
}
