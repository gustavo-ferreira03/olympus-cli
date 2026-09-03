import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DecodedIdentity {
  sub: string;
  email: string;
  username: string;
  name: string;
  picture: string;
  exp: number;
}

export interface Credentials {
  token: string;
  identity: DecodedIdentity;
}

interface StoredCredentials {
  token: string;
  expiresAt: string;
}

export function credentialsDir(): string {
  return resolve(homedir(), ".shipd", "olympus");
}

const CREDENTIALS_PATH = resolve(credentialsDir(), "credentials.json");

/**
 * Decode JWT payload without signature verification.
 *
 * Safe for local display and expiry checks only. Convex validates the signature
 * server-side on every request.
 */
function decodeJwtPayload(token: string): DecodedIdentity {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Invalid JWT format");
  }
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload) as DecodedIdentity;
}

export function saveCredentials(token: string): DecodedIdentity {
  const identity = decodeJwtPayload(token);
  const expiresAt = new Date(identity.exp * 1000).toISOString();
  const dir = credentialsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const data: StoredCredentials = { token, expiresAt };
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  return identity;
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const stored = JSON.parse(raw) as Partial<StoredCredentials>;
    if (!stored.token) return null;
    const identity = decodeJwtPayload(stored.token);
    if (identity.exp <= Math.floor(Date.now() / 1000)) return null;
    return { token: stored.token, identity };
  } catch {
    return null;
  }
}

export function clearCredentials(): boolean {
  if (existsSync(CREDENTIALS_PATH)) {
    unlinkSync(CREDENTIALS_PATH);
    return true;
  }
  return false;
}

export function requireAuth(): Credentials {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in. Run: olympus auth login");
    process.exit(1);
  }
  return credentials;
}
