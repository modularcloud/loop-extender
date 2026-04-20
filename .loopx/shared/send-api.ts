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

const client = new OpenAI();

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
  });
  writeFileSync(RESPONSE_ID_FILE, response.id);
  console.error(`submitted background response ${response.id}`);
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "incomplete"]);
let lastStatus: string | undefined;
while (!TERMINAL.has(response.status ?? "")) {
  if (response.status !== lastStatus) {
    console.error(`waiting for ${response.id} (${response.status})...`);
    lastStatus = response.status ?? undefined;
  }
  await new Promise((r) => setTimeout(r, 2000));
  response = await client.responses.retrieve(response.id);
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
rmSync(PROMPT_FILE);
if (existsSync(RESPONSE_ID_FILE)) rmSync(RESPONSE_ID_FILE);
console.error("=== Feedback received from GPT-5.4-Pro ===");

execFileSync(BIN, ["output", "--goto", "check-feedback-done"], {
  stdio: "inherit",
});
