import OpenAI from "openai";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
const RESPONSE_ID_FILE = `${ROOT}/.loopx/${WORKFLOW}/.response-id.tmp`;

if (!existsSync(PROMPT_FILE)) {
  console.error(`Error: prompt file not found at ${PROMPT_FILE}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_FILE, "utf8");

if (existsSync(FEEDBACK_FILE)) rmSync(FEEDBACK_FILE);

const client = new OpenAI({ timeout: 60_000, maxRetries: 4 });

// Resume a prior background response if one was persisted from an earlier run
// that died before the response reached a terminal state. Background responses
// are retained for ~10 minutes, so this lets a retried loopx iteration pick up
// where the previous one left off instead of spending money on a duplicate run.
let response: Awaited<ReturnType<typeof client.responses.retrieve>> | null =
  null;
if (existsSync(RESPONSE_ID_FILE)) {
  const priorId = readFileSync(RESPONSE_ID_FILE, "utf8").trim();
  if (priorId) {
    console.error(`resuming background response ${priorId}...`);
    try {
      response = await client.responses.retrieve(priorId);
    } catch (err: any) {
      console.error(
        `could not resume ${priorId} (${err?.status ?? "error"}); starting a new request`,
      );
      rmSync(RESPONSE_ID_FILE);
    }
  }
}

if (!response) {
  console.error(`requesting gpt-5.4-pro (thinking=${THINKING})...`);
  response = await client.responses.create({
    model: "gpt-5.4-pro",
    reasoning: { effort: THINKING },
    input: prompt,
    background: true,
    prompt_cache_key: WORKFLOW,
    prompt_cache_retention: "24h",
  });
  writeFileSync(RESPONSE_ID_FILE, response.id);
  console.error(`submitted background response ${response.id}`);
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "incomplete"]);
// Each failed retrieve has already been through the SDK's 4 retries, so 20
// consecutive failures represents tens of minutes of sustained OpenAI
// unavailability — wider than any single inference window.
const MAX_POLL_FAILURES = 20;
// Inference can take up to ~30 min at xhigh thinking; 1 h bounds worst-case
// hangs where a response is accepted but never transitions to terminal.
// Measured from response.created_at so resumes don't reset the clock.
const DEADLINE_SECS = 60 * 60;
let lastStatus: string | undefined;
let pollFailures = 0;
while (!TERMINAL.has(response.status ?? "")) {
  const ageSecs = Math.floor(Date.now() / 1000) - response.created_at;
  if (ageSecs > DEADLINE_SECS) {
    console.error(
      `${response.id} exceeded ${DEADLINE_SECS / 60}m deadline (age ${ageSecs}s, status ${response.status}); cancelling`,
    );
    try {
      await client.responses.cancel(response.id);
    } catch (err: any) {
      const status = err?.status ?? err?.code ?? "error";
      console.error(`cancel ${response.id} failed (${status})`);
    }
    rmSync(RESPONSE_ID_FILE, { force: true });
    throw new Error(
      `gpt-5.4-pro response ${response.id} did not complete within ${DEADLINE_SECS / 60} minutes (last status: ${response.status ?? "unknown"})`,
    );
  }
  if (response.status !== lastStatus) {
    console.error(`waiting for ${response.id} (${response.status})...`);
    lastStatus = response.status ?? undefined;
  }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    response = await client.responses.retrieve(response.id);
    pollFailures = 0;
  } catch (err: any) {
    pollFailures++;
    const status = err?.status ?? err?.code ?? "error";
    console.error(
      `poll ${response.id} failed (${status}); retry ${pollFailures}/${MAX_POLL_FAILURES}`,
    );
    if (pollFailures >= MAX_POLL_FAILURES) throw err;
  }
}

if (response.status !== "completed") {
  const detail =
    response.status === "incomplete"
      ? ` (${response.incomplete_details?.reason ?? "unknown reason"})`
      : response.error?.message
        ? `: ${response.error.message}`
        : "";
  throw new Error(
    `gpt-5.4-pro response ${response.id} ended in status ${response.status}${detail}`,
  );
}

const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
const inputTokens = response.usage?.input_tokens ?? 0;
if (inputTokens > 0) {
  const pct = Math.round((100 * cachedTokens) / inputTokens);
  console.error(
    `tokens: input=${inputTokens} cached=${cachedTokens} (${pct}%) output=${response.usage?.output_tokens ?? 0}`,
  );
}

const answer =
  response.output_text ??
  (response.output ?? [])
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("\n");

if (!answer) {
  throw new Error("gpt-5.4-pro returned no output text");
}

writeFileSync(FEEDBACK_FILE, answer);
// force:true — external cleanup (reinstall, git clean, sibling workflow) can
// remove these scratch files mid-run; crashing here would skip the goto to
// check-feedback-done and strand the loop.
rmSync(PROMPT_FILE, { force: true });
rmSync(RESPONSE_ID_FILE, { force: true });
console.error("=== Feedback received from GPT-5.4-Pro ===");

execFileSync(BIN, ["output", "--goto", "check-feedback-done"], {
  stdio: "inherit",
});
