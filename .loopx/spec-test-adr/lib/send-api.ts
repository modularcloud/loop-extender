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

if (!existsSync(PROMPT_FILE)) {
  console.error(`Error: prompt file not found at ${PROMPT_FILE}`);
  process.exit(1);
}

const prompt = readFileSync(PROMPT_FILE, "utf8");

if (existsSync(FEEDBACK_FILE)) rmSync(FEEDBACK_FILE);

const client = new OpenAI();

console.error(`requesting gpt-5.4-pro (thinking=${THINKING})...`);

const response = await client.responses.create({
  model: "gpt-5.4-pro",
  reasoning: { effort: THINKING },
  input: prompt,
});

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
console.error("=== Feedback received from GPT-5.4-Pro ===");

execFileSync(BIN, ["output", "--goto", "check-feedback-done"], {
  stdio: "inherit",
});
