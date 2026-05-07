import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";

describe("TEST-SPEC §9.3 abort after final yield", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  it("T-API-66/T-API-66a/T-API-66b: abort after maxIterations final yield surfaces on next interaction", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "final-yield-max-runs.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
printf '{"result":"ok"}'
`,
    );

    const driverCode = `
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const interactions = ["next", "return", "throw"];
const results = [];
for (const interaction of interactions) {
  const controller = new AbortController();
  const gen = run("ralph", {
    cwd: projectDir,
    maxIterations: 1,
    signal: controller.signal,
  });
  const first = await gen.next();
  controller.abort();
  let rejected = false;
  let message = "";
  try {
    if (interaction === "next") await gen.next();
    if (interaction === "return") await gen.return(undefined);
    if (interaction === "throw") await gen.throw(new Error("consumer-err"));
  } catch (error) {
    rejected = true;
    message = String(error?.message ?? error);
  }
  results.push({
    interaction,
    yielded: first.value?.result === "ok",
    done: first.done === false,
    rejected,
    abortMessage: /abort/i.test(message),
    consumerError: /consumer-err/.test(message),
  });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        yielded: true,
        done: true,
        rejected: true,
        abortMessage: true,
        consumerError: false,
      });
    }
  });

  it("T-API-66c/T-API-66d/T-API-66e: abort after stop:true final yield surfaces on next interaction", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "final-yield-stop-runs.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const interactions = ["next", "return", "throw"];
const results = [];
for (const interaction of interactions) {
  const controller = new AbortController();
  const gen = run("ralph", {
    cwd: projectDir,
    maxIterations: 5,
    signal: controller.signal,
  });
  const first = await gen.next();
  controller.abort();
  let rejected = false;
  let message = "";
  try {
    if (interaction === "next") await gen.next();
    if (interaction === "return") await gen.return(undefined);
    if (interaction === "throw") await gen.throw(new Error("consumer-err"));
  } catch (error) {
    rejected = true;
    message = String(error?.message ?? error);
  }
  results.push({
    interaction,
    yielded: first.value?.stop === true,
    done: first.done === false,
    rejected,
    abortMessage: /abort/i.test(message),
    consumerError: /consumer-err/.test(message),
  });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        yielded: true,
        done: true,
        rejected: true,
        abortMessage: true,
        consumerError: false,
      });
    }
  });
});
