import { defineCommand } from "citty";
import { api, getClient } from "../platform/convex.ts";
import { printJson, statusBadge, truncate } from "../terminal/format.ts";

function displayStatus(status: unknown): string {
  const value = typeof status === "string" ? status.toLowerCase() : "unknown";
  let badgeStatus = value;
  if (value === "verifying") badgeStatus = "running";
  else if (value === "submitted") badgeStatus = "accepted";
  else if (value === "voided") badgeStatus = "rejected";
  else if (value === "errored") badgeStatus = "failed";
  return statusBadge(badgeStatus);
}

function timestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return new Date(value).toISOString();
}

const view = defineCommand({
  meta: {
    name: "delivery-verification view",
    description: "View delivery verification details for a challenge",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output the complete API payload as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const result: any = await client.query(api.deliveryVerify.getSubmitVerification, {
      problemId: args.id,
    });
    if (args.json) return printJson(result);
    if (!result) {
      console.log(`\n  No delivery verification exists for ${args.id}.\n`);
      return;
    }
    console.log(`\n  Delivery verification for ${args.id}`);
    console.log(`  ${displayStatus(result.status)}`);
    console.log(`  Started: ${timestamp(result.clickedAt)}`);
    console.log(`  Updated: ${timestamp(result.updatedAt)}`);
    if (typeof result.progress === "number") console.log(`  Progress: ${result.progress}%`);
    if (result.progressStep) console.log(`  Step: ${result.progressStep}`);
    if (result.failureSummary)
      console.log(`  Failure: ${truncate(String(result.failureSummary), 500)}`);
    console.log("");
  },
});

export default defineCommand({
  meta: {
    name: "delivery-verification",
    alias: "delivery-verify",
    description: "Delivery verification operations",
  },
  subCommands: { view },
});
