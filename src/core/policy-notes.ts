import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { credentialsDir } from "../platform/auth.ts";
import { toPublicCheckKey } from "./expected.ts";
import {
  matchingPolicyNotes,
  policyFingerprint,
  type PolicyGraph,
  type PolicyState,
} from "./policy-graph.ts";

type Graph = NonNullable<PolicyGraph>;
type Receipt = { fingerprint: string; token: string; acknowledged: boolean };

function receiptPath(challengeId: string, noteId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(challengeId) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(noteId))
    throw new Error("Invalid challenge or note ID");
  return resolve(credentialsDir(), "policy-note-receipts", challengeId, `${noteId}.json`);
}

function load(challengeId: string, noteId: string): Receipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(receiptPath(challengeId, noteId), "utf8"));
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof (value as Receipt).fingerprint === "string"
      && typeof (value as Receipt).token === "string"
      && typeof (value as Receipt).acknowledged === "boolean"
    )
      return value as Receipt;
    throw new Error("Invalid note receipt");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function save(challengeId: string, noteId: string, receipt: Receipt): void {
  const path = receiptPath(challengeId, noteId);
  mkdirSync(resolve(credentialsDir(), "policy-note-receipts", challengeId), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function dotted(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      root,
    );
}

function noteFingerprint(state: PolicyState, graph: Graph, note: Graph["notes"][number]): string {
  const root = note.when.check
    ? Object.entries((state.checks ?? {}) as Record<string, unknown>).find(
        ([key]) => toPublicCheckKey(key) === note.when.check,
      )?.[1]
    : state;
  return policyFingerprint({
    challengeId: state.challengeId,
    versionId: state.versionId,
    graphHash: policyFingerprint(graph),
    note,
    facts: note.when.all.map(({ path }) => dotted(root, path)),
  });
}

export function pendingPolicyNotes(
  state: PolicyState,
  graph: Graph,
  visibleIds: string[],
): string[] {
  const applicable = new Set(matchingPolicyNotes(state, graph).map((note) => note.id));
  return graph.notes
    .filter(
      (note) =>
        note.requires_ack === true && visibleIds.includes(note.id) && applicable.has(note.id),
    )
    .filter((note) => {
      const receipt = load(state.challengeId, note.id);
      return !receipt?.acknowledged || receipt.fingerprint !== noteFingerprint(state, graph, note);
    })
    .map((note) => note.id);
}

export function readPolicyNote(state: PolicyState, graph: Graph, noteId: string) {
  const note = graph.notes.find((item) => item.id === noteId);
  if (!note || !matchingPolicyNotes(state, graph).some((item) => item.id === noteId))
    throw new Error(`Note ${noteId} is not applicable to the current state`);
  const fingerprint = noteFingerprint(state, graph, note);
  if (!note.requires_ack)
    return {
      id: note.id,
      severity: note.severity,
      message: note.message,
      requiresAck: false,
      token: null,
    };
  const previous = load(state.challengeId, noteId);
  if (previous?.acknowledged && previous.fingerprint === fingerprint)
    return {
      id: note.id,
      severity: note.severity,
      message: note.message,
      requiresAck: false,
      token: null,
    };
  const token = randomUUID();
  save(state.challengeId, noteId, { fingerprint, token, acknowledged: false });
  return {
    id: note.id,
    severity: note.severity,
    message: note.message,
    requiresAck: note.requires_ack === true,
    token,
  };
}

export function acknowledgePolicyNote(
  state: PolicyState,
  graph: Graph,
  noteId: string,
  token: string,
) {
  const note = graph.notes.find((item) => item.id === noteId);
  if (!note?.requires_ack || !matchingPolicyNotes(state, graph).some((item) => item.id === noteId))
    throw new Error(`Note ${noteId} does not require acknowledgment in the current state`);
  const receipt = load(state.challengeId, noteId);
  const expected = noteFingerprint(state, graph, note);
  const given = Buffer.from(token);
  const saved = Buffer.from(receipt?.token ?? "");
  if (
    !receipt
    || receipt.fingerprint !== expected
    || given.length !== saved.length
    || !timingSafeEqual(given, saved)
  )
    throw new Error("Note read token is missing or stale; read the note again");
  receipt.acknowledged = true;
  save(state.challengeId, noteId, receipt);
  return { id: noteId, acknowledged: true, fingerprint: expected };
}
