import { exec, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { defineCommand } from "citty";
import { clearCredentials, loadCredentials, saveCredentials } from "../auth.ts";
import { getAuthUrl } from "../config.ts";

function openBrowser(url: string): void {
    if (process.platform === "win32") {
        // `start` is a cmd.exe built-in, not a standalone executable
        exec(`start "" "${url.replace(/"/g, '\\"')}"`, () => { });
    }
    else {
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        execFile(cmd, [url], () => { });
    }
}
function prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
const login = defineCommand({
    meta: { name: "auth login", description: "Sign in via browser" },
    run: async () => {
        const authUrl = getAuthUrl();
        console.log(`\n  Opening browser...\n  ${authUrl}\n`);
        openBrowser(authUrl);
        const token = await prompt("  Paste your token: ");
        if (!token) {
            console.error("  No token provided.");
            process.exit(1);
        }
        try {
            const identity = saveCredentials(token);
            const expiresAt = new Date(identity.exp * 1000).toLocaleDateString();
            console.log(`\n  Logged in as ${identity.name || identity.email}`);
            if (identity.username)
                console.log(`  Username:  @${identity.username}`);
            console.log(`  Expires:   ${expiresAt}\n`);
        }
        catch {
            console.error("  Invalid token.");
            process.exit(1);
        }
    },
});
const logout = defineCommand({
    meta: { name: "auth logout", description: "Clear stored credentials" },
    run: async () => {
        const removed = clearCredentials();
        console.log(removed ? "  Logged out." : "  Not logged in.");
    },
});
const status = defineCommand({
    meta: { name: "auth status", alias: "whoami", description: "Show current auth status" },
    args: {
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const creds = loadCredentials();
        if (!creds) {
            if (args.json) {
                console.log(JSON.stringify({ authenticated: false }));
            }
            else {
                console.log("  Not logged in. Run: olympus auth login");
            }
            return;
        }
        const { identity } = creds;
        const expiresAt = new Date(identity.exp * 1000);
        const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (args.json) {
            console.log(JSON.stringify({
                authenticated: true,
                userId: identity.sub,
                email: identity.email,
                username: identity.username,
                name: identity.name,
                expiresAt: expiresAt.toISOString(),
                daysLeft,
            }));
        }
        else {
            console.log(`  Logged in as ${identity.name || identity.email}`);
            if (identity.username)
                console.log(`  Username:  @${identity.username}`);
            console.log(`  User ID:   ${identity.sub}`);
            console.log(`  Expires:   ${expiresAt.toLocaleDateString()} (${daysLeft}d)`);
        }
    },
});
export default defineCommand({
    meta: { name: "auth", description: "Authentication" },
    default: "status",
    subCommands: { login, logout, status },
});
