import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { credentialsDir } from "./auth.ts";
const PROD_URL = "https://shipd.ai/quests/olympus";
const DEV_URL = "http://localhost:3006/quests/olympus";
const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
    version: string;
    name: string;
    private?: boolean;
};
const VERSION: string = packageJson.version;
const PACKAGE_NAME: string = packageJson.name;
/**
 * Optional npm package used by `olympus update` for this fork. It is disabled
 * by default while package.json is private. Set OLYMPUS_UPDATE_PACKAGE to your
 * own published scope when/if you publish the maintained fork.
 */
const UPDATE_PACKAGE_NAME: string | null =
    process.env.OLYMPUS_UPDATE_PACKAGE || (packageJson.private ? null : PACKAGE_NAME);
export { VERSION, PACKAGE_NAME, UPDATE_PACKAGE_NAME };

export interface CliConfig {
    convexUrl: string;
    minCliVersion: string;
    fetchedAt: string;
}

interface VersionCache {
    latestVersion: string;
    fetchedAt: string;
}
const CONFIG_PATH = resolve(credentialsDir(), "config.json");
const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes
const VERSION_CACHE_PATH = resolve(credentialsDir(), "version-check.json");
const VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
function isValidCliConfig(value: unknown): value is CliConfig {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value as Record<string, unknown>;
    return (typeof candidate.convexUrl === "string" &&
        candidate.convexUrl.length > 0 &&
        typeof candidate.minCliVersion === "string" &&
        candidate.minCliVersion.length > 0 &&
        typeof candidate.fetchedAt === "string" &&
        candidate.fetchedAt.length > 0);
}
function isValidVersionCache(value: unknown): value is VersionCache {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value as Record<string, unknown>;
    return (typeof candidate.latestVersion === "string" &&
        candidate.latestVersion.length > 0 &&
        typeof candidate.fetchedAt === "string" &&
        candidate.fetchedAt.length > 0);
}
/** OLYMPUS_URL override, or NODE_ENV=development → localhost */
function getBaseUrl(): string {
    if (process.env.OLYMPUS_URL)
        return process.env.OLYMPUS_URL;
    return process.env.NODE_ENV === "development" ? DEV_URL : PROD_URL;
}
/** Auth page URL for browser login flow */
export function getAuthUrl(): string {
    return `${getBaseUrl()}/cli-auth`;
}
/** Load cached config or fetch fresh from the frontend */
export async function getConfig(): Promise<CliConfig> {
    if (existsSync(CONFIG_PATH)) {
        try {
            const cached = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
            if (isValidCliConfig(cached)) {
                const age = Date.now() - new Date(cached.fetchedAt).getTime();
                if (age < CONFIG_TTL_MS)
                    return cached;
            }
        }
        catch {
            // Stale or corrupt — refetch
        }
    }
    const baseUrl = getBaseUrl();
    try {
        const res = await fetch(`${baseUrl}/api/cli/config`);
        if (res.ok) {
            const data = (await res.json()) as Record<string, unknown>;
            if (!data ||
                typeof data !== "object" ||
                Array.isArray(data) ||
                typeof data.convexUrl !== "string" ||
                !data.convexUrl ||
                typeof data.minCliVersion !== "string" ||
                !data.minCliVersion) {
                throw new Error(`CLI config from ${baseUrl}/api/cli/config is missing convexUrl.\n` +
                    `  The Olympus deployment is likely missing VITE_CONVEX_URL in its server runtime.\n` +
                    `  Temporary workaround: set OLYMPUS_CONVEX_URL manually.`);
            }
            const config: CliConfig = {
                convexUrl: data.convexUrl,
                minCliVersion: data.minCliVersion,
                fetchedAt: new Date().toISOString(),
            };
            writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
            return config;
        }
    }
    catch (error) {
        if (error instanceof Error) {
            throw error;
        }
    }
    throw new Error(`Could not fetch CLI config from ${baseUrl}/api/cli/config\n` +
        `  Set OLYMPUS_URL if using a non-default environment.`);
}
/** Get Convex cloud URL, with env override */
export async function getConvexUrl(): Promise<string> {
    if (process.env.OLYMPUS_CONVEX_URL)
        return process.env.OLYMPUS_CONVEX_URL;
    const config = await getConfig();
    return config.convexUrl;
}
/** Compare semver strings numerically (e.g. "0.10.0" > "0.9.0") */
function semverGt(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0))
            return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0))
            return false;
    }
    return false;
}
async function getLatestPublishedVersion(): Promise<string | null> {
    if (!UPDATE_PACKAGE_NAME)
        return null;
    if (existsSync(VERSION_CACHE_PATH)) {
        try {
            const cached = JSON.parse(readFileSync(VERSION_CACHE_PATH, "utf-8"));
            if (isValidVersionCache(cached)) {
                const age = Date.now() - new Date(cached.fetchedAt).getTime();
                if (age < VERSION_CACHE_TTL_MS)
                    return cached.latestVersion;
            }
        }
        catch {
            // Stale or corrupt — refetch
        }
    }
    try {
        const encodedName = encodeURIComponent(UPDATE_PACKAGE_NAME);
        const res = await fetch(`https://registry.npmjs.org/${encodedName}/latest`, {
            headers: { Accept: "application/json" },
        });
        if (!res.ok)
            return null;
        const data = (await res.json()) as { version?: unknown };
        if (typeof data.version !== "string" || !data.version)
            return null;
        const cache = {
            latestVersion: data.version,
            fetchedAt: new Date().toISOString(),
        };
        writeFileSync(VERSION_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
        return cache.latestVersion;
    }
    catch {
        return null;
    }
}
/** Check if CLI version meets minimum required by server and whether npm has a newer release. */
export async function checkVersion() {
    if (process.env.OLYMPUS_NO_UPDATE_CHECK === "1")
        return;
    const [configResult, latestResult] = await Promise.allSettled([
        getConfig(),
        getLatestPublishedVersion(),
    ]);
    try {
        if (configResult.status === "fulfilled" &&
            semverGt(configResult.value.minCliVersion, VERSION)) {
            console.error(`\n  CLI v${VERSION} is below minimum required v${configResult.value.minCliVersion}` +
                `\n  Run: olympus update\n`);
            return;
        }
        if (latestResult.status === "fulfilled" &&
            latestResult.value &&
            semverGt(latestResult.value, VERSION)) {
            console.error(`\n  CLI v${VERSION} is behind latest published v${latestResult.value}` +
                `\n  Run: olympus update\n`);
        }
    }
    catch {
        // Don't block on version check failures
    }
}
