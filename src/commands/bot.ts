import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { api, getClient } from "../platform/convex.ts";
import { printJson } from "../terminal/format.ts";

const DEFAULT_INTERVAL_SECONDS = 2;
const DEFAULT_TIMEOUT_SECONDS = 120;

type BotMessage = {
  id?: unknown;
  role?: unknown;
  status?: unknown;
  content?: unknown;
  error?: unknown;
};

type BotThread = {
  enabled?: unknown;
  contextSummary?: unknown;
  failingChecks?: unknown;
  warningChecks?: unknown;
  remainingToday?: unknown;
  messages?: unknown;
};

function messages(thread: BotThread | null | undefined): BotMessage[] {
  return Array.isArray(thread?.messages)
    ? thread.messages.filter(
        (message): message is BotMessage =>
          message !== null && typeof message === "object" && !Array.isArray(message),
      )
    : [];
}

function messageId(message: BotMessage): string | null {
  return typeof message.id === "string" ? message.id : null;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
  return parsed;
}

function messageText(message: BotMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function requestedMessage(args: { message?: string; file?: string }): string {
  if (args.message !== undefined && args.file !== undefined)
    throw new Error("Provide the message as an argument or with --file, not both");
  let raw = args.message;
  if (args.file === "-") raw = readFileSync(0, "utf8");
  else if (args.file) raw = readFileSync(args.file, "utf8");
  const content = raw?.trim();
  if (!content) throw new Error("A non-empty message is required");
  return content;
}

async function waitForReply(
  client: Awaited<ReturnType<typeof getClient>>,
  problemId: string,
  knownIds: Set<string>,
  intervalMs: number,
  timeoutMs: number,
): Promise<{ thread: BotThread | null; reply: BotMessage }> {
  const startedAt = Date.now();
  while (true) {
    const thread = (await client.query(api.assistant.getThread, { problemId })) as BotThread | null;
    const reply = messages(thread).find((message) => {
      if (message.role !== "assistant") return false;
      const id = messageId(message);
      return id === null || !knownIds.has(id);
    });
    if (reply?.status === "complete" || reply?.status === "error" || reply?.error)
      return { thread, reply };
    if (Date.now() - startedAt >= timeoutMs)
      throw new Error(
        `Timed out waiting for Shipd Bot after ${Math.round(timeoutMs / 1000)} seconds`,
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function printThread(thread: BotThread | null, problemId: string): void {
  if (!thread?.enabled) {
    console.log(`\n  Shipd Bot is not enabled for ${problemId}.\n`);
    return;
  }
  console.log(`\n  Shipd Bot · ${problemId}`);
  const summary = typeof thread.contextSummary === "string" ? thread.contextSummary : "no summary";
  console.log(`  Context: ${summary}`);
  if (typeof thread.remainingToday === "number")
    console.log(`  Messages remaining today: ${thread.remainingToday}`);
  const entries = messages(thread);
  if (entries.length === 0) {
    console.log("\n  No messages.\n");
    return;
  }
  for (const message of entries) {
    const role = message.role === "assistant" ? "Shipd Bot" : "You";
    const status =
      typeof message.status === "string" && message.status !== "complete"
        ? ` · ${message.status}`
        : "";
    console.log(`\n  ${role}${status}`);
    const content = messageText(message);
    for (const line of content.split("\n")) console.log(`    ${line}`);
    if (message.error) console.log(`    Error: ${String(message.error)}`);
  }
  console.log("");
}

async function getThread(problemId: string): Promise<BotThread | null> {
  const client = await getClient();
  return client.query(api.assistant.getThread, { problemId }) as Promise<BotThread | null>;
}

const view = defineCommand({
  meta: { name: "bot view", description: "View the Shipd Bot conversation for a challenge" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output the complete thread as JSON" },
  },
  run: async ({ args }) => {
    const thread = await getThread(args.id);
    if (args.json) return printJson(thread);
    printThread(thread, args.id);
  },
});

const send = defineCommand({
  meta: { name: "bot send", description: "Send a message to Shipd Bot and wait for its reply" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    message: { type: "positional", description: "Message text" },
    file: { type: "string", description: "Read the message from a file; use - for stdin" },
    interval: {
      type: "string",
      description: `Polling interval in seconds (default ${DEFAULT_INTERVAL_SECONDS})`,
    },
    timeout: {
      type: "string",
      description: `Maximum wait in seconds (default ${DEFAULT_TIMEOUT_SECONDS})`,
    },
    json: { type: "boolean", description: "Output the completed thread as JSON" },
  },
  run: async ({ args }) => {
    const content = requestedMessage(args);
    const intervalMs = positiveNumber(args.interval, DEFAULT_INTERVAL_SECONDS, "interval") * 1000;
    const timeoutMs = positiveNumber(args.timeout, DEFAULT_TIMEOUT_SECONDS, "timeout") * 1000;
    const client = await getClient();
    const before = (await client.query(api.assistant.getThread, {
      problemId: args.id,
    })) as BotThread | null;
    if (!before?.enabled) throw new Error(`Shipd Bot is not enabled for ${args.id}`);
    const knownIds = new Set(
      messages(before)
        .map(messageId)
        .filter((id): id is string => id !== null),
    );
    await client.mutation(api.assistant.sendMessage, { problemId: args.id, content });
    const { thread, reply } = await waitForReply(client, args.id, knownIds, intervalMs, timeoutMs);
    if (args.json) printJson(thread);
    else printThread(thread, args.id);
    if (reply.status === "error" || reply.error) process.exitCode = 1;
  },
});

const clear = defineCommand({
  meta: { name: "bot clear", description: "Clear the Shipd Bot conversation for a challenge" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    yes: { type: "boolean", description: "Confirm clearing the conversation" },
    json: { type: "boolean", description: "Output JSON" },
  },
  run: async ({ args }) => {
    if (!args.yes) throw new Error("Refusing to clear the conversation without --yes");
    const client = await getClient();
    await client.mutation(api.assistant.clearThread, { problemId: args.id });
    const result = { status: "cleared", challengeId: args.id };
    if (args.json) printJson(result);
    else console.log(`\n  Cleared Shipd Bot conversation for ${args.id}.\n`);
  },
});

export default defineCommand({
  meta: {
    name: "bot",
    alias: "shipd-bot",
    description: "Chat with Shipd Bot about an Olympus challenge",
  },
  subCommands: { view, send, clear },
});
