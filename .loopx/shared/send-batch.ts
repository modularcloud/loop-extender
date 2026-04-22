import OpenAI, { toFile } from "openai";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = process.env.LOOPX_PROJECT_ROOT!;
const WORKFLOW = process.env.LOOPX_WORKFLOW!;
const BIN = process.env.LOOPX_BIN!;
const THINKING = (process.env.GPT_PRO_THINKING ?? "medium") as
  | "medium"
  | "high"
  | "xhigh";

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is required. Set via: loopx env set OPENAI_API_KEY <key>",
  );
  process.exit(1);
}

const PROMPT_FILE = `${ROOT}/.loopx/${WORKFLOW}/.prompt.tmp`;
const FEEDBACK_FILE = `${ROOT}/.loopx/${WORKFLOW}/.feedback.tmp`;

if (!existsSync(PROMPT_FILE)) {
  console.error(`Error: prompt file not found at ${PROMPT_FILE}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_FILE, "utf8");

if (existsSync(FEEDBACK_FILE)) rmSync(FEEDBACK_FILE);

const client = new OpenAI({ timeout: 60_000, maxRetries: 4 });

const batchLine = JSON.stringify({
  custom_id: `gpt54-${randomUUID()}`,
  method: "POST",
  url: "/v1/responses",
  body: {
    model: "gpt-5.4-pro",
    reasoning: { effort: THINKING },
    input: prompt,
    prompt_cache_key: WORKFLOW,
    prompt_cache_retention: "24h",
  },
});

const inputFile = await client.files.create(
  {
    file: await toFile(
      Buffer.from(batchLine + "\n", "utf8"),
      `batch-${Date.now()}.jsonl`,
      { type: "application/x-ndjson" },
    ),
    purpose: "batch",
  },
  { timeout: 300_000 },
);

const batch = await client.batches.create({
  input_file_id: inputFile.id,
  endpoint: "/v1/responses",
  completion_window: "24h",
});

console.error(`submitted batch: ${batch.id}`);

let b = batch;
let lastStatus: string | undefined;
// Each failed retrieve has already been through the SDK's 4 retries, so 20
// consecutive failures represents tens of minutes of sustained OpenAI
// unavailability. Crashing would forfeit the batch and double-submit next run.
const MAX_POLL_FAILURES = 20;
let pollFailures = 0;
while (
  !b.output_file_id &&
  !b.error_file_id &&
  !["failed", "expired", "cancelled"].includes(b.status)
) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    b = await client.batches.retrieve(batch.id);
    pollFailures = 0;
  } catch (err: any) {
    pollFailures++;
    const status = err?.status ?? err?.code ?? "error";
    console.error(
      `poll batch ${batch.id} failed (${status}); retry ${pollFailures}/${MAX_POLL_FAILURES}`,
    );
    if (pollFailures >= MAX_POLL_FAILURES) throw err;
    continue;
  }
  if (b.status !== lastStatus) {
    console.error(`waiting for batch ${b.id} (${b.status})...`);
    lastStatus = b.status;
  }
}

if (b.error_file_id) {
  const err = await (
    await client.files.content(b.error_file_id, { timeout: 300_000 })
  ).text();
  throw new Error(`Batch error: ${err}`);
}
if (!b.output_file_id) {
  throw new Error(`Batch ${batch.id} ended in status ${b.status}`);
}

const outText = await (
  await client.files.content(b.output_file_id, { timeout: 300_000 })
).text();
const line = JSON.parse(outText.trim().split(/\r?\n/)[0]);
if (line.error) throw new Error(`Batch error: ${line.error.message}`);

const resp = line.response.body as { output_text?: string; output?: any[] };
const answer =
  resp.output_text ??
  (resp.output ?? [])
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("\n");

writeFileSync(FEEDBACK_FILE, answer);
rmSync(PROMPT_FILE);
console.error("=== Feedback received from GPT-5.4-Pro ===");

execFileSync(BIN, ["output", "--goto", "check-feedback-done"], {
  stdio: "inherit",
});
