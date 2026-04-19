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

const ADR_0001 = `${ROOT}/adr/0001-adr-process.md`;
const ADR_0002 = `${ROOT}/adr/0002-run-subcommand.md`;
const SPEC = `${ROOT}/SPEC.md`;

for (const f of [ADR_0001, ADR_0002, SPEC]) {
  if (!existsSync(f)) {
    console.error(`Error: ${f} not found`);
    process.exit(1);
  }
}

const prompt = `ADR 0002 has been accepted. The next step in the process is to update SPEC.md to incorporate the changes described in ADR 0002. Review the current SPEC.md against ADR 0002 and let me know if the SPEC updates look correct and complete, or if anything else in the SPEC needs to be changed.

adr/0002-run-subcommand.md (accepted — do not modify):
${readFileSync(ADR_0002, "utf8")}

SPEC.md (target of updates):
${readFileSync(SPEC, "utf8")}`;

const FEEDBACK_FILE = `${ROOT}/.loopx/${WORKFLOW}/.feedback.tmp`;
if (existsSync(FEEDBACK_FILE)) rmSync(FEEDBACK_FILE);

const client = new OpenAI();

const batchLine = JSON.stringify({
  custom_id: `gpt54-${randomUUID()}`,
  method: "POST",
  url: "/v1/responses",
  body: {
    model: "gpt-5.4-pro",
    reasoning: { effort: THINKING },
    input: prompt,
  },
});

const inputFile = await client.files.create({
  file: await toFile(
    Buffer.from(batchLine + "\n", "utf8"),
    `batch-${Date.now()}.jsonl`,
    { type: "application/x-ndjson" },
  ),
  purpose: "batch",
});

const batch = await client.batches.create({
  input_file_id: inputFile.id,
  endpoint: "/v1/responses",
  completion_window: "24h",
});

console.error(`submitted batch: ${batch.id}`);

let b = batch;
let lastStatus: string | undefined;
while (
  !b.output_file_id &&
  !b.error_file_id &&
  !["failed", "expired", "cancelled"].includes(b.status)
) {
  await new Promise((r) => setTimeout(r, 2000));
  b = await client.batches.retrieve(batch.id);
  if (b.status !== lastStatus) {
    console.error(`waiting for batch ${b.id} (${b.status})...`);
    lastStatus = b.status;
  }
}

if (b.error_file_id) {
  const err = await (await client.files.content(b.error_file_id)).text();
  throw new Error(`Batch error: ${err}`);
}
if (!b.output_file_id) {
  throw new Error(`Batch ${batch.id} ended in status ${b.status}`);
}

const outText = await (await client.files.content(b.output_file_id)).text();
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
console.error("=== Feedback received from GPT-5.4-Pro ===");

execFileSync(BIN, ["output", "--goto", "apply-feedback"], {
  stdio: "inherit",
});
