import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { createEnvFile, withGlobalEnv } from "../helpers/env.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";

describe("TEST-SPEC §4.9 RunOptions.env", () => {
  let project: TempProject | null = null;
  const extraTempDirs: string[] = [];

  async function makeXdgConfigHome(vars: Record<string, string>): Promise<string> {
    const configHome = await mkdtemp(join(tmpdir(), "loopx-api-xdg-"));
    extraTempDirs.push(configHome);
    await mkdir(join(configHome, "loopx"), { recursive: true });
    await createEnvFile(join(configHome, "loopx", "env"), vars);
    return configHome;
  }

  async function makeHomeWithGlobalEnv(vars: Record<string, string>): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "loopx-api-home-"));
    extraTempDirs.push(home);
    await mkdir(join(home, ".config", "loopx"), { recursive: true });
    await createEnvFile(join(home, ".config", "loopx", "env"), vars);
    return home;
  }

  async function makeTmpParent(prefix = "loopx-api-real-parent-"): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), prefix));
    extraTempDirs.push(parent);
    return parent;
  }

  function lingeringLoopxRunDirs(parent: string): string[] {
    return readdirSync(parent).filter(
      (name) =>
        name.startsWith("loopx-") && !name.startsWith("loopx-nodepath-shim-"),
    );
  }

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    while (extraTempDirs.length > 0) {
      await rm(extraTempDirs.pop()!, { recursive: true, force: true }).catch(() => {});
    }
  });

  forEachRuntime((runtime) => {
    it("T-API-50: runPromise() supplies RunOptions.env values to scripts", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MY_API_VAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MY_API_VAR: "from-run-options" },
});
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("from-run-options");
    });

    it("T-API-50a: run() supplies RunOptions.env values to scripts", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env-run.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MY_API_VAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MY_API_VAR: "from-run-options" },
})) {}
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("from-run-options");
    });

    it("T-API-50b: RunOptions.env overrides local env-file and inherited env values", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env-precedence.txt");
      await createEnvFile(join(project.dir, "local.env"), {
        PRECEDENCE_VAR: "from-env-file",
      });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.PRECEDENCE_VAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  env: { PRECEDENCE_VAR: "from-run-options" },
});
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { PRECEDENCE_VAR: "from-inherited" },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("from-run-options");
    });

    it("T-API-50c: RunOptions.env applies to cross-workflow goto destinations", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env-cross-workflow.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MY_API_VAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("alpha", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MY_API_VAR: "cross-workflow" },
});
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("cross-workflow");
    });

    it("T-API-50d: RunOptions.env is snapshotted at call time", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env-snapshot.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.SNAPSHOT_VAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const env = { SNAPSHOT_VAR: "before" };
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
});
env.SNAPSHOT_VAR = "after";
await p;
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("before");
    });

    it("T-API-50e: RunOptions.env preserves tricky non-NUL string values byte-for-byte", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "api-env-tricky.txt");
      const tricky = " leading spaces : equals=kept : trailing spaces ";

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.TRICKY_VALUE ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { TRICKY_VALUE: ${JSON.stringify(tricky)} },
});
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe(tricky);
    });
  });

  it("T-API-50f: concurrent runPromise() calls receive isolated RunOptions.env values", async () => {
    project = await createTempProject();
    const markerAlpha = join(project.dir, "alpha-env.txt");
    const markerBeta = join(project.dir, "beta-env.txt");
    const releaseAlpha = join(project.dir, "release-alpha");
    const releaseBeta = join(project.dir, "release-beta");

    await createWorkflowScript(
      project,
      "alpha",
      "index",
      ".sh",
      `#!/bin/bash
printf '%s' "$MYVAR" > "${markerAlpha}"
while [ ! -e "${releaseAlpha}" ]; do sleep 0.01; done
printf '{"stop":true}'
`,
    );
    await createWorkflowScript(
      project,
      "beta",
      "index",
      ".sh",
      `#!/bin/bash
printf '%s' "$MYVAR" > "${markerBeta}"
while [ ! -e "${releaseBeta}" ]; do sleep 0.01; done
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runPromise } from "loopx";

async function waitFor(path) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + path);
    await delay(10);
  }
}

const pAlpha = runPromise("alpha", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "alpha-value" },
});
const pBeta = runPromise("beta", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "beta-value" },
});
await Promise.all([
  waitFor(${JSON.stringify(markerAlpha)}),
  waitFor(${JSON.stringify(markerBeta)}),
]);
writeFileSync(${JSON.stringify(releaseAlpha)}, "");
writeFileSync(${JSON.stringify(releaseBeta)}, "");
await Promise.all([pAlpha, pBeta]);
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(markerAlpha, "utf-8")).toBe("alpha-value");
    expect(readFileSync(markerBeta, "utf-8")).toBe("beta-value");
  });

  it("T-API-50g: concurrent run() generators receive isolated RunOptions.env values", async () => {
    project = await createTempProject();
    const markerAlpha = join(project.dir, "alpha-env-run.txt");
    const markerBeta = join(project.dir, "beta-env-run.txt");
    const releaseAlpha = join(project.dir, "release-alpha-run");
    const releaseBeta = join(project.dir, "release-beta-run");

    await createWorkflowScript(
      project,
      "alpha",
      "index",
      ".sh",
      `#!/bin/bash
printf '%s' "$MYVAR" > "${markerAlpha}"
while [ ! -e "${releaseAlpha}" ]; do sleep 0.01; done
printf '{"stop":true}'
`,
    );
    await createWorkflowScript(
      project,
      "beta",
      "index",
      ".sh",
      `#!/bin/bash
printf '%s' "$MYVAR" > "${markerBeta}"
while [ ! -e "${releaseBeta}" ]; do sleep 0.01; done
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "loopx";

async function waitFor(path) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + path);
    await delay(10);
  }
}

const ga = run("alpha", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "alpha-value" },
});
const gb = run("beta", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "beta-value" },
});
const aNext = ga.next();
const bNext = gb.next();
await Promise.all([
  waitFor(${JSON.stringify(markerAlpha)}),
  waitFor(${JSON.stringify(markerBeta)}),
]);
writeFileSync(${JSON.stringify(releaseAlpha)}, "");
writeFileSync(${JSON.stringify(releaseBeta)}, "");
await Promise.all([aNext, bNext]);
for await (const _ of ga) {}
for await (const _ of gb) {}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(markerAlpha, "utf-8")).toBe("alpha-value");
    expect(readFileSync(markerBeta, "utf-8")).toBe("beta-value");
  });

  it("T-API-50h: tricky non-NUL RunOptions.env values are preserved byte-for-byte on both API surfaces", async () => {
    project = await createTempProject();
    const markerRoot = await mkdtemp(join(tmpdir(), "loopx-env-markers-"));
    extraTempDirs.push(markerRoot);
    const tricky: Record<string, string> = {
      V_LEAD_TRAIL: "  leading and trailing  ",
      V_EQUALS: "key=value=other",
      V_HASH: "before#after",
      V_QUOTES: "she said \"hi\" and 'bye'",
      V_BACKSLASH: "a\\b\\\\c\\\"d",
      V_UNICODE: "cafe \u{1F680} Han",
      V_NEWLINE: "line1\nline2",
      V_CRLF: "line1\r\nline2",
      V_TAB: "col1\tcol2",
      V_SPACE_ONLY: "   ",
    };
    const keys = Object.keys(tricky);

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { mkdirSync, writeFileSync } from "node:fs";
const keys = ${JSON.stringify(keys)};
const markerRoot = process.env.MARKER_ROOT!;
const surface = process.env.SURFACE!;
mkdirSync(markerRoot, { recursive: true });
for (const key of keys) {
  writeFileSync(\`\${markerRoot}/\${surface}-\${key}\`, process.env[key] ?? "");
}
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    for (const surface of ["promise", "generator"] as const) {
      const call =
        surface === "promise"
          ? `await runPromise("ralph", options);`
          : `for await (const _ of run("ralph", options)) {}`;
      const driverCode = `
import { run, runPromise } from "loopx";
const options = {
  cwd: ${JSON.stringify(project.dir)},
  env: ${JSON.stringify({ ...tricky, MARKER_ROOT: markerRoot, SURFACE: surface })},
};
${call}
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project.dir,
      });
      expect(result.exitCode).toBe(0);
      for (const [key, value] of Object.entries(tricky)) {
        expect(readFileSync(join(markerRoot, `${surface}-${key}`))).toEqual(
          Buffer.from(value, "utf8"),
        );
      }
    }
  });

  it("T-API-51a: RunOptions.env protocol-name entries are silently overridden by real protocol values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "protocol-values.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  LOOPX_BIN: process.env.LOOPX_BIN,
  LOOPX_PROJECT_ROOT: process.env.LOOPX_PROJECT_ROOT,
  LOOPX_WORKFLOW: process.env.LOOPX_WORKFLOW,
  LOOPX_WORKFLOW_DIR: process.env.LOOPX_WORKFLOW_DIR,
  LOOPX_TMPDIR: process.env.LOOPX_TMPDIR,
  tmpdirIsDirectory: process.env.LOOPX_TMPDIR ? "unknown-in-script" : "missing",
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: {
    LOOPX_BIN: "/tmp/fake-bin",
    LOOPX_PROJECT_ROOT: "/tmp/fake-root",
    LOOPX_WORKFLOW: "fake",
    LOOPX_WORKFLOW_DIR: "/tmp/fake-wfdir",
    LOOPX_TMPDIR: "/tmp/fake-tmp",
  },
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.LOOPX_BIN).not.toBe("/tmp/fake-bin");
    expect(observed.LOOPX_PROJECT_ROOT).toBe(project.dir);
    expect(observed.LOOPX_WORKFLOW).toBe("ralph");
    expect(observed.LOOPX_WORKFLOW_DIR).toBe(join(project.loopxDir, "ralph"));
    expect(observed.LOOPX_TMPDIR).not.toBe("/tmp/fake-tmp");
    expect(result.stderr).not.toMatch(/LOOPX_(BIN|PROJECT_ROOT|WORKFLOW|WORKFLOW_DIR|TMPDIR).*overrid/i);
  });

  it("T-API-51a2: run() silently overrides all RunOptions.env protocol-name entries with real protocol values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "protocol-values-run.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, statSync, writeFileSync } from "node:fs";
const tmpdir = process.env.LOOPX_TMPDIR;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  LOOPX_BIN: process.env.LOOPX_BIN,
  LOOPX_PROJECT_ROOT: process.env.LOOPX_PROJECT_ROOT,
  LOOPX_WORKFLOW: process.env.LOOPX_WORKFLOW,
  LOOPX_WORKFLOW_DIR: process.env.LOOPX_WORKFLOW_DIR,
  LOOPX_TMPDIR: tmpdir,
  tmpdirIsDirectory: tmpdir ? existsSync(tmpdir) && statSync(tmpdir).isDirectory() : false,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
const env = {};
env.LOOPX_BIN = "/tmp/fake-bin";
env.LOOPX_PROJECT_ROOT = "/tmp/fake-root";
env.LOOPX_WORKFLOW = "fake";
env.LOOPX_WORKFLOW_DIR = "/tmp/fake-wfdir";
env.LOOPX_TMPDIR = "/tmp/fake-tmp";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.LOOPX_BIN).not.toBe("/tmp/fake-bin");
    expect(observed.LOOPX_PROJECT_ROOT).toBe(project.dir);
    expect(observed.LOOPX_WORKFLOW).toBe("ralph");
    expect(observed.LOOPX_WORKFLOW_DIR).toBe(join(project.loopxDir, "ralph"));
    expect(observed.LOOPX_TMPDIR).not.toBe("/tmp/fake-tmp");
    expect(observed.tmpdirIsDirectory).toBe(true);
    expect(result.stderr).not.toMatch(/LOOPX_(BIN|PROJECT_ROOT|WORKFLOW|WORKFLOW_DIR|TMPDIR).*overrid/i);
  });

  it("T-API-51b: RunOptions.env overrides local env-file values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "options-over-local.txt");
    await createEnvFile(join(project.dir, "local.env"), {
      MYVAR: "from-file",
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MYVAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("from-options");
  });

  it("T-API-51c: RunOptions.env overrides global env-file values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "options-over-global.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MYVAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    await withGlobalEnv({ MYVAR: "from-global" }, async () => {
      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project!.dir)},
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project!.dir,
        env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("from-options");
    });
  });

  it("T-API-51d: RunOptions.env overrides inherited environment values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "options-over-inherited.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MYVAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { MYVAR: "from-inherited" },
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("from-options");
  });

  it("T-API-51e: RunOptions.env wins the full precedence chain on runPromise()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "options-full-chain-promise.txt");
    await createEnvFile(join(project.dir, "local.env"), {
      MYVAR: "3",
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MYVAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    await withGlobalEnv({ MYVAR: "2" }, async () => {
      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project!.dir)},
  envFile: "local.env",
  env: { MYVAR: "4" },
  maxIterations: 1,
});
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project!.dir,
        env: { MYVAR: "1", XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("4");
    });
  });

  it("T-API-51f: RunOptions.env wins the full precedence chain on run()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "options-full-chain-run.txt");
    await createEnvFile(join(project.dir, "local.env"), {
      MYVAR: "3",
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.MYVAR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    await withGlobalEnv({ MYVAR: "2" }, async () => {
      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project!.dir)},
  envFile: "local.env",
  env: { MYVAR: "4" },
  maxIterations: 1,
})) {}
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project!.dir,
        env: { MYVAR: "1", XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("4");
    });
  });

  it("T-API-52a/T-API-52b: run() snapshots RunOptions.env keys and values at call time", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-env-snapshot.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  MYVAR: process.env.MYVAR,
  NEWVAR: process.env.NEWVAR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
const env = { MYVAR: "A" };
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
env.MYVAR = "B";
env.NEWVAR = "added";
for await (const _ of gen) {}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      MYVAR: "A",
    });
  });

  it("T-API-52c: run() invokes RunOptions.env enumerable getters exactly once at call time", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-env-getter.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  MYVAR: process.env.MYVAR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { readFileSync } from "node:fs";
import { run } from "loopx";
let count = 0;
let backing = "initial";
const env = {};
Object.defineProperty(env, "MYVAR", {
  enumerable: true,
  get() {
    count += 1;
    return backing;
  },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
const countAfterRun = count;
backing = "mutated";
const countAfterMutate = count;
for await (const _ of gen) {}
console.log(JSON.stringify({
  countAfterRun,
  countAfterMutate,
  countAfterSettle: count,
  observed: JSON.parse(readFileSync(${JSON.stringify(marker)}, "utf-8")),
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      countAfterRun: 1,
      countAfterMutate: 1,
      countAfterSettle: 1,
      observed: { MYVAR: "initial" },
    });
  });

  it("T-API-52d: runPromise() reuses one RunOptions.env getter snapshot across iterations", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "promise-env-getter.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
previous.push(process.env.MYVAR);
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: previous.length >= 3 }));
`,
    );

    const driverCode = `
import { readFileSync } from "node:fs";
import { runPromise } from "loopx";
let count = 0;
let backing = "initial";
const env = {};
Object.defineProperty(env, "MYVAR", {
  enumerable: true,
  get() {
    count += 1;
    return backing;
  },
});
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const countAfterCall = count;
backing = "mutated";
const countAfterMutate = count;
await p;
console.log(JSON.stringify({
  countAfterCall,
  countAfterMutate,
  countAfterResolve: count,
  observed: JSON.parse(readFileSync(${JSON.stringify(marker)}, "utf-8")),
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      countAfterCall: 1,
      countAfterMutate: 1,
      countAfterResolve: 1,
      observed: ["initial", "initial", "initial"],
    });
  });

  it("T-API-52/T-API-52f: runPromise() snapshots RunOptions.env values and key set at call time", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "promise-env-snapshot.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  MYVAR: process.env.MYVAR,
  NEWVAR: process.env.NEWVAR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const env = { MYVAR: "initial" };
const promise = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
env.MYVAR = "mutated";
env.NEWVAR = "added";
await promise;
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      MYVAR: "initial",
    });
  });

  it("T-API-52e: RunOptions.env proxy success path snapshots ownKeys and get traps once per call on both surfaces", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "proxy-env-snapshot.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
previous.push({
  surface: process.env.SURFACE,
  MYVAR: process.env.MYVAR,
  OTHERVAR: process.env.OTHERVAR,
});
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: previous.filter((entry) => entry.surface === process.env.SURFACE).length >= 3 }));
`,
    );

    const driverCode = `
import { readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};

async function runVariant(surface) {
  let ownKeysCount = 0;
  let getCount = 0;
  const valueGetCounts = {};
  const target = { MYVAR: "initial", OTHERVAR: "second", SURFACE: surface };
  const env = new Proxy(target, {
    ownKeys(t) {
      ownKeysCount += 1;
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, key) {
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    get(t, key) {
      if (typeof key === "string") {
        getCount += 1;
        valueGetCounts[key] = (valueGetCounts[key] ?? 0) + 1;
      }
      return Reflect.get(t, key);
    },
  });
  if (surface === "run") {
    const gen = run("ralph", { cwd: projectDir, env, maxIterations: 3 });
    const afterCall = { ownKeysCount, getCount, valueGetCounts: { ...valueGetCounts } };
    for await (const _ of gen) {}
    return { surface, afterCall, afterDone: { ownKeysCount, getCount, valueGetCounts: { ...valueGetCounts } } };
  }
  const promise = runPromise("ralph", { cwd: projectDir, env, maxIterations: 3 });
  const afterCall = { ownKeysCount, getCount, valueGetCounts: { ...valueGetCounts } };
  await promise;
  return { surface, afterCall, afterDone: { ownKeysCount, getCount, valueGetCounts: { ...valueGetCounts } } };
}

const runResult = await runVariant("run");
const promiseResult = await runVariant("promise");
console.log(JSON.stringify({
  runResult,
  promiseResult,
  observed: JSON.parse(readFileSync(marker, "utf-8")),
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const variant of [parsed.runResult, parsed.promiseResult]) {
      expect(variant.afterCall.ownKeysCount).toBe(1);
      expect(variant.afterDone.ownKeysCount).toBe(1);
      expect(variant.afterCall.getCount).toBe(3);
      expect(variant.afterDone.getCount).toBe(3);
      expect(variant.afterCall.valueGetCounts).toEqual({
        MYVAR: 1,
        OTHERVAR: 1,
        SURFACE: 1,
      });
      expect(variant.afterDone.valueGetCounts).toEqual(
        variant.afterCall.valueGetCounts,
      );
    }
    expect(parsed.observed).toEqual([
      { surface: "run", MYVAR: "initial", OTHERVAR: "second" },
      { surface: "run", MYVAR: "initial", OTHERVAR: "second" },
      { surface: "run", MYVAR: "initial", OTHERVAR: "second" },
      { surface: "promise", MYVAR: "initial", OTHERVAR: "second" },
      { surface: "promise", MYVAR: "initial", OTHERVAR: "second" },
      { surface: "promise", MYVAR: "initial", OTHERVAR: "second" },
    ]);
  });

  it("T-API-52e2: runPromise() proxy descriptor-only and get-only success paths are not re-read across iterations", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "promise-proxy-narrow-snapshot.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
previous.push({
  variant: process.env.VARIANT,
  MYVAR: process.env.MYVAR,
  OTHERVAR: process.env.OTHERVAR,
});
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: previous.filter((entry) => entry.variant === process.env.VARIANT).length >= 3 }));
`,
    );

    const driverCode = `
import { readFileSync } from "node:fs";
import { runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};

let descCount = 0;
const descriptorEnv = new Proxy(
  { MYVAR: "initial", OTHERVAR: "second", VARIANT: "descriptor" },
  {
    getOwnPropertyDescriptor(t, key) {
      descCount += 1;
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  },
);
const descriptorPromise = runPromise("ralph", { cwd: projectDir, env: descriptorEnv, maxIterations: 3 });
const descAfterCall = descCount;
await descriptorPromise;
const descAfterDone = descCount;

let getCount = 0;
const valueGetCounts = {};
const getEnv = new Proxy(
  { MYVAR: "initial", OTHERVAR: "second", VARIANT: "get" },
  {
    get(t, key) {
      if (typeof key === "string") {
        getCount += 1;
        valueGetCounts[key] = (valueGetCounts[key] ?? 0) + 1;
      }
      return Reflect.get(t, key);
    },
  },
);
const getPromise = runPromise("ralph", { cwd: projectDir, env: getEnv, maxIterations: 3 });
const getAfterCall = getCount;
const valueGetAfterCall = { ...valueGetCounts };
await getPromise;
console.log(JSON.stringify({
  descAfterCall,
  descAfterDone,
  getAfterCall,
  getAfterDone: getCount,
  valueGetAfterCall,
  valueGetAfterDone: { ...valueGetCounts },
  observed: JSON.parse(readFileSync(marker, "utf-8")),
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.descAfterDone).toBe(parsed.descAfterCall);
    expect(parsed.getAfterCall).toBe(3);
    expect(parsed.getAfterDone).toBe(3);
    expect(parsed.valueGetAfterCall).toEqual({
      MYVAR: 1,
      OTHERVAR: 1,
      VARIANT: 1,
    });
    expect(parsed.valueGetAfterDone).toEqual(parsed.valueGetAfterCall);
    expect(parsed.observed).toEqual([
      { variant: "descriptor", MYVAR: "initial", OTHERVAR: "second" },
      { variant: "descriptor", MYVAR: "initial", OTHERVAR: "second" },
      { variant: "descriptor", MYVAR: "initial", OTHERVAR: "second" },
      { variant: "get", MYVAR: "initial", OTHERVAR: "second" },
      { variant: "get", MYVAR: "initial", OTHERVAR: "second" },
      { variant: "get", MYVAR: "initial", OTHERVAR: "second" },
    ]);
  });

  it("T-API-53/T-API-53a/T-API-53b/T-API-53c/T-API-53d/T-API-53e/T-API-53f/T-API-53g/T-API-54/T-API-54a/T-API-54b/T-API-54c/T-API-54d/T-API-54f/T-API-54g/T-API-54h: run() rejects invalid RunOptions.env shapes and entry values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "invalid-env-run-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run } from "loopx";
const variants = [
  ["T-API-53", () => null],
  ["T-API-53a", () => []],
  ["T-API-53b", () => function badEnv() {}],
  ["T-API-53c", () => "string"],
  ["T-API-53d", () => 42],
  ["T-API-53e", () => true],
  ["T-API-53f", () => Symbol("bad")],
  ["T-API-53g", () => 1n],
  ["T-API-54", () => ({ MYVAR: 42 })],
  ["T-API-54a", () => ({ MYVAR: undefined })],
  ["T-API-54b", () => ({ MYVAR: null })],
  ["T-API-54c", () => ({ MYVAR: { nested: "value" } })],
  ["T-API-54d", () => {
    const env = {};
    Object.defineProperty(env, "MYVAR", {
      enumerable: true,
      get() {
        return 42;
      },
    });
    return env;
  }],
  ["T-API-54f", () => ({ MYVAR: true })],
  ["T-API-54g", () => ({ MYVAR: Symbol("bad") })],
  ["T-API-54h", () => ({ MYVAR: 1n })],
];
const results = [];
for (const [id, makeEnv] of variants) {
  let syncThrow = false;
  let rejected = false;
  try {
    const gen = run("ralph", {
      cwd: ${JSON.stringify(project.dir)},
      env: makeEnv(),
      maxIterations: 1,
    });
    try {
      await gen.next();
    } catch {
      rejected = true;
    }
  } catch {
    syncThrow = true;
  }
  results.push({ id, syncThrow, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ syncThrow: false, rejected: true });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-54e/T-API-55: runPromise() rejects invalid RunOptions.env shapes and entry values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "invalid-env-promise-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const variants = [
  ["null", () => null],
  ["array", () => []],
  ["function", () => function badEnv() {}],
  ["string", () => "string"],
  ["number", () => 42],
  ["boolean", () => true],
  ["symbol", () => Symbol("bad")],
  ["bigint", () => 1n],
  ["number-entry", () => ({ MYVAR: 42 })],
  ["undefined-entry", () => ({ MYVAR: undefined })],
  ["null-entry", () => ({ MYVAR: null })],
  ["object-entry", () => ({ MYVAR: { nested: "value" } })],
  ["T-API-54e", () => {
    const env = {};
    Object.defineProperty(env, "MYVAR", {
      enumerable: true,
      get() {
        return 42;
      },
    });
    return env;
  }],
  ["boolean-entry", () => ({ MYVAR: true })],
  ["symbol-entry", () => ({ MYVAR: Symbol("bad") })],
  ["bigint-entry", () => ({ MYVAR: 1n })],
];
const results = [];
for (const [id, makeEnv] of variants) {
  let syncThrow = false;
  let rejected = false;
  try {
    const p = runPromise("ralph", {
      cwd: ${JSON.stringify(project.dir)},
      env: makeEnv(),
      maxIterations: 1,
    });
    try {
      await p;
    } catch {
      rejected = true;
    }
  } catch {
    syncThrow = true;
  }
  results.push({ id, syncThrow, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ syncThrow: false, rejected: true });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-56i: run() applies own-enumerable-string filtering and accepts structural env shapes", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-env-filtering.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
previous.push({
  variant: process.env.VARIANT,
  OWN: process.env.OWN ?? null,
  INHERITED: process.env.INHERITED ?? null,
  INHERITED_NUMBER: process.env.INHERITED_NUMBER ?? null,
  VISIBLE: process.env.VISIBLE ?? null,
  HIDDEN: process.env.HIDDEN ?? null,
  MYVAR: process.env.MYVAR ?? null,
});
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
class EnvClass {
  MYVAR = "from-class";
  VARIANT = "class";
}
const variants = [];
{
  const env = Object.create({ INHERITED: "proto-val" });
  env.OWN = "own-val";
  env.VARIANT = "inherited";
  variants.push(env);
}
{
  const sym = Symbol("SYM");
  const env = { OWN: "own-val", VARIANT: "symbol", [sym]: "sym-val" };
  variants.push(env);
}
{
  const env = { VISIBLE: "visible-val", VARIANT: "non-enumerable" };
  Object.defineProperty(env, "HIDDEN", { value: "hidden-val", enumerable: false });
  variants.push(env);
}
{
  const env = Object.create(null);
  env.MYVAR = "from-null-prototype";
  env.VARIANT = "null-prototype";
  variants.push(env);
}
variants.push(new EnvClass());
{
  const env = new Map([["MYVAR", "from-map"]]);
  env.VARIANT = "map";
  variants.push(env);
}
{
  const sym = Symbol("SYM-throw");
  const env = { OWN: "own-val", VARIANT: "symbol-getter" };
  Object.defineProperty(env, sym, { enumerable: true, get() { throw new Error("symbol-getter-should-never-fire-run"); } });
  variants.push(env);
}
{
  const env = { VISIBLE: "visible-val", VARIANT: "hidden-getter" };
  Object.defineProperty(env, "HIDDEN", { enumerable: false, get() { throw new Error("non-enumerable-getter-should-never-fire-run"); } });
  variants.push(env);
}
{
  const env = Object.create({ INHERITED_NUMBER: 42 });
  env.OWN = "own-val";
  env.VARIANT = "inherited-number";
  variants.push(env);
}
for (const env of variants) {
  for await (const _ of run("ralph", { cwd: projectDir, env, maxIterations: 1 })) {}
}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/should-never-fire-run|snapshot|options\.env/i);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      {
        variant: "inherited",
        OWN: "own-val",
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "symbol",
        OWN: "own-val",
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "non-enumerable",
        OWN: null,
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: "visible-val",
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "null-prototype",
        OWN: null,
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: "from-null-prototype",
      },
      {
        variant: "class",
        OWN: null,
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: "from-class",
      },
      {
        variant: "map",
        OWN: null,
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "symbol-getter",
        OWN: "own-val",
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "hidden-getter",
        OWN: null,
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: "visible-val",
        HIDDEN: null,
        MYVAR: null,
      },
      {
        variant: "inherited-number",
        OWN: "own-val",
        INHERITED: null,
        INHERITED_NUMBER: null,
        VISIBLE: null,
        HIDDEN: null,
        MYVAR: null,
      },
    ]);
  });

  it("T-API-57b/T-API-57c: equals-sign and empty RunOptions.env names are not option-shape errors", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-57b", { "BAD=KEY": "val" }],
  ["T-API-57c", { "": "empty-key-value" }],
];
const results = [];
for (const [id, env] of variants) {
  let rejected = false;
  let message = "";
  try {
    await runPromise("ralph", { cwd: projectDir, env, maxIterations: 1 });
  } catch (error) {
    rejected = true;
    message = String(error?.message ?? error);
  }
  results.push({ id, rejected, optionShapeError: /options\\.env|env shape|environment.*shape|string value/i.test(message) });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry.optionShapeError).toBe(false);
    }
  });

  it("T-API-58/T-API-58b/T-API-58c/T-API-58d/T-API-58d2/T-API-58e/T-API-58e2/T-API-58f/T-API-58f2/T-API-58g/T-API-58g2: protocol variables override lower-tier NUL values before spawn", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "protocol-nul-override.json");
    const tmpParent = await makeTmpParent("loopx-api-protocol-nul-");
    const localEnvFile = join(project.dir, "local-protocol.env");
    const xdgConfigHome = join(project.dir, "xdg");
    await mkdir(join(xdgConfigHome, "loopx"), { recursive: true });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
const name = process.env.OBSERVE_NAME!;
const value = process.env[name] ?? null;
previous.push({
  source: process.env.OBSERVE_SOURCE,
  surface: process.env.OBSERVE_SURFACE,
  name,
  value,
  custom: process.env.CUSTOM ?? null,
  tmpdirIsDirectory: name === "LOOPX_TMPDIR" && value ? existsSync(value) && statSync(value).isDirectory() : null,
});
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { writeFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const localEnvFile = ${JSON.stringify(localEnvFile)};
const globalEnvFile = ${JSON.stringify(join(xdgConfigHome, "loopx", "env"))};
const names = ["LOOPX_WORKFLOW", "LOOPX_TMPDIR", "LOOPX_BIN", "LOOPX_PROJECT_ROOT", "LOOPX_WORKFLOW_DIR"];
async function drive(surface, options) {
  if (surface === "promise") {
    await runPromise("ralph", { cwd: projectDir, maxIterations: 1, ...options });
    return;
  }
  for await (const _ of run("ralph", { cwd: projectDir, maxIterations: 1, ...options })) {}
}
await drive("promise", {
  env: {
    LOOPX_WORKFLOW: "user-fake",
    CUSTOM: "user-val",
    OBSERVE_NAME: "LOOPX_WORKFLOW",
    OBSERVE_SOURCE: "ordinary",
    OBSERVE_SURFACE: "promise",
  },
});
for (const name of names) {
  for (const surface of ["promise", "run"]) {
    await drive(surface, {
      env: {
        [name]: "bad\\0value",
        OBSERVE_NAME: name,
        OBSERVE_SOURCE: "run-options",
        OBSERVE_SURFACE: surface,
      },
    });
  }

  writeFileSync(localEnvFile, name + "=bad\\0value\\n");
  for (const surface of ["promise", "run"]) {
    await drive(surface, {
      envFile: localEnvFile,
      env: {
        OBSERVE_NAME: name,
        OBSERVE_SOURCE: "local-env-file",
        OBSERVE_SURFACE: surface,
      },
    });
  }

  writeFileSync(globalEnvFile, name + "=bad\\0value\\n");
  for (const surface of ["promise", "run"]) {
    await drive(surface, {
      env: {
        OBSERVE_NAME: name,
        OBSERVE_SOURCE: "global-env-file",
        OBSERVE_SURFACE: surface,
      },
    });
  }
}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent, XDG_CONFIG_HOME: xdgConfigHome },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/spawn|nul|override|warning/i);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed).toHaveLength(31);
    const ordinary = observed[0];
    expect(ordinary).toMatchObject({
      source: "ordinary",
      surface: "promise",
      name: "LOOPX_WORKFLOW",
      value: "ralph",
      custom: "user-val",
    });
    for (const entry of observed.slice(1)) {
      expect(entry.value).not.toBe("bad\u0000value");
      if (entry.name === "LOOPX_WORKFLOW") {
        expect(entry.value).toBe("ralph");
      } else if (entry.name === "LOOPX_PROJECT_ROOT") {
        expect(entry.value).toBe(project.dir);
      } else if (entry.name === "LOOPX_WORKFLOW_DIR") {
        expect(entry.value).toBe(join(project.loopxDir, "ralph"));
      } else if (entry.name === "LOOPX_TMPDIR") {
        expect(entry.value.startsWith(tmpParent)).toBe(true);
        expect(entry.tmpdirIsDirectory).toBe(true);
      } else if (entry.name === "LOOPX_BIN") {
        expect(entry.value).toMatch(/\b(loopx|tsx|bun|node)/i);
      }
    }
  });

  it("T-API-55: invalid RunOptions.env shape rejects via runPromise(), not synchronous throw", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
let syncThrow = false;
let rejected = false;
try {
  const p = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: null,
  });
  try {
    await p;
  } catch {
    rejected = true;
  }
} catch {
  syncThrow = true;
}
console.log(JSON.stringify({ syncThrow, rejected }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      syncThrow: false,
      rejected: true,
    });
  });

  it("T-API-55a: non-string RunOptions.env entry values reject before script spawn", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { BAD_VALUE: 123 },
  });
} catch {
  rejected = true;
}
console.log(JSON.stringify({ rejected }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-55b: non-string RunOptions.env entry values reject even with maxIterations: 0", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const variants = [
  { BAD_VALUE: 123 },
  { BAD_VALUE: false },
  { BAD_VALUE: Symbol("bad") },
  { BAD_VALUE: 1n },
];
const results = [];
for (const env of variants) {
  let rejected = false;
  try {
    await runPromise("ralph", {
      cwd: ${JSON.stringify(project.dir)},
      maxIterations: 0,
      env,
    });
  } catch {
    rejected = true;
  }
  results.push(rejected);
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, true, true, true]);
  });

  it("T-API-55c: throwing RunOptions.env getter is captured and surfaced through pre-iteration rejection", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const options = { cwd: ${JSON.stringify(project.dir)} };
Object.defineProperty(options, "env", {
  enumerable: true,
  get() {
    throw new Error("env getter boom");
  },
});
let syncThrow = false;
let rejected = false;
try {
  const p = runPromise("ralph", options);
  try {
    await p;
  } catch {
    rejected = true;
  }
} catch {
  syncThrow = true;
}
console.log(JSON.stringify({ syncThrow, rejected }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      syncThrow: false,
      rejected: true,
    });
  });

  it("T-API-55d: throwing enumerable getter inside RunOptions.env rejects through the pre-iteration path", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const env = {};
Object.defineProperty(env, "BAD_VALUE", {
  enumerable: true,
  get() {
    throw new Error("env entry getter boom");
  },
});
let syncThrow = false;
let rejected = false;
try {
  const p = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
  });
  try {
    await p;
  } catch {
    rejected = true;
  }
} catch {
  syncThrow = true;
}
console.log(JSON.stringify({ syncThrow, rejected }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      syncThrow: false,
      rejected: true,
    });
  });

  it("T-API-56/T-API-56a/T-API-56b: RunOptions.env uses only own enumerable string-keyed entries", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "env-filtering.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  OWN: process.env.OWN,
  INHERITED: process.env.INHERITED,
  VISIBLE: process.env.VISIBLE,
  HIDDEN: process.env.HIDDEN,
  SYM: process.env.SYM,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const sym = Symbol("SYM");
const proto = { INHERITED: "proto-val" };
const env = Object.create(proto);
env.OWN = "own-val";
env.VISIBLE = "visible-val";
env[sym] = "sym-val";
Object.defineProperty(env, "HIDDEN", {
  value: "hidden-val",
  enumerable: false,
});
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      OWN: "own-val",
      VISIBLE: "visible-val",
    });
  });

  it("T-API-56c: null-prototype RunOptions.env is accepted", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "env-null-prototype.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  MYVAR: process.env.MYVAR,
  OTHERVAR: process.env.OTHERVAR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const env = Object.create(null);
env.MYVAR = "from-options";
env.OTHERVAR = "second-value";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      MYVAR: "from-options",
      OTHERVAR: "second-value",
    });
  });

  it("T-API-56d/T-API-56e/T-API-56j: filtered RunOptions.env getters are never invoked", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "env-filtered-getters.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  OWN: process.env.OWN,
  HIDDEN: process.env.HIDDEN,
  INHERITED_THROW: process.env.INHERITED_THROW,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise, run } from "loopx";
const sym = Symbol("SYM_THROW");
const proto = {};
Object.defineProperty(proto, "INHERITED_THROW", {
  enumerable: true,
  get() {
    throw new Error("inherited-getter-should-never-fire");
  },
});
const env = Object.create(proto);
env.OWN = "own-val";
Object.defineProperty(env, sym, {
  enumerable: true,
  get() {
    throw new Error("symbol-getter-should-never-fire");
  },
});
Object.defineProperty(env, "HIDDEN", {
  enumerable: false,
  get() {
    throw new Error("non-enumerable-getter-should-never-fire");
  },
});
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
});
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/getter-should-never-fire/);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      OWN: "own-val",
    });
  });

  it("T-API-56f: inherited non-string RunOptions.env values are ignored before validation", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "env-inherited-non-string.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  OWN: process.env.OWN,
  INHERITED_NUMBER: process.env.INHERITED_NUMBER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const proto = { INHERITED_NUMBER: 42 };
const env = Object.create(proto);
env.OWN = "own-val";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      OWN: "own-val",
    });
  });

  it("T-API-56g/T-API-56h: class-instance env is accepted, Map env contributes no entries", async () => {
    project = await createTempProject();
    const classMarker = join(project.dir, "env-class.json");
    const mapMarker = join(project.dir, "env-map.json");

    await createWorkflowScript(
      project,
      "classenv",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(classMarker)}, JSON.stringify({ MYVAR: process.env.MYVAR }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );
    await createWorkflowScript(
      project,
      "mapenv",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(mapMarker)}, JSON.stringify({ MAP_SHOULD_NOT_LEAK: process.env.MAP_SHOULD_NOT_LEAK }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
class Env {
  MYVAR = "from-class";
}
await runPromise("classenv", {
  cwd: ${JSON.stringify(project.dir)},
  env: new Env(),
});
await runPromise("mapenv", {
  cwd: ${JSON.stringify(project.dir)},
  env: new Map([["MAP_SHOULD_NOT_LEAK", "x"]]),
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(classMarker, "utf-8"))).toEqual({
      MYVAR: "from-class",
    });
    expect(JSON.parse(readFileSync(mapMarker, "utf-8"))).toEqual({});
  });

  it("T-API-59: RunOptions.env does not redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "api-xdg-no-redirect.json");
    const realConfig = await makeXdgConfigHome({ MARKER: "real" });
    const fakeConfig = await makeXdgConfigHome({ MARKER: "fake" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { XDG_CONFIG_HOME: ${JSON.stringify(fakeConfig)} },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { XDG_CONFIG_HOME: realConfig },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      XDG_CONFIG_HOME: fakeConfig,
      MARKER: "real",
    });
  });

  it("T-API-59a: RunOptions.env does not redirect global env-file lookup via HOME fallback", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "api-home-no-redirect.json");
    const realHome = await makeHomeWithGlobalEnv({ MARKER: "real" });
    const fakeHome = await makeHomeWithGlobalEnv({ MARKER: "fake" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  HOME: process.env.HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { HOME: ${JSON.stringify(fakeHome)} },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        HOME: realHome,
        XDG_CONFIG_HOME: undefined as unknown as string,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      HOME: fakeHome,
      MARKER: "real",
    });
  });

  it("T-API-59b: run() RunOptions.env does not redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "api-run-xdg-no-redirect.json");
    const realConfig = await makeXdgConfigHome({ MARKER: "real" });
    const fakeConfig = await makeXdgConfigHome({ MARKER: "fake" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { XDG_CONFIG_HOME: ${JSON.stringify(fakeConfig)} },
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { XDG_CONFIG_HOME: realConfig },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      XDG_CONFIG_HOME: fakeConfig,
      MARKER: "real",
    });
  });

  it("T-API-59c: run() RunOptions.env does not redirect global env-file lookup via HOME fallback", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "api-run-home-no-redirect.json");
    const realHome = await makeHomeWithGlobalEnv({ MARKER: "real" });
    const fakeHome = await makeHomeWithGlobalEnv({ MARKER: "fake" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  HOME: process.env.HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { HOME: ${JSON.stringify(fakeHome)} },
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        HOME: realHome,
        XDG_CONFIG_HOME: undefined as unknown as string,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      HOME: fakeHome,
      MARKER: "real",
    });
  });

  it("T-API-59d: RunOptions.envFile does not redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "envfile-xdg-no-redirect.json");
    const realConfig = await makeXdgConfigHome({ MARKER: "real" });
    const fakeConfig = await makeXdgConfigHome({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      XDG_CONFIG_HOME: fakeConfig,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { XDG_CONFIG_HOME: realConfig },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      XDG_CONFIG_HOME: fakeConfig,
      MARKER: "real",
    });
  });

  it("T-API-59e: RunOptions.envFile does not redirect global env-file lookup via HOME fallback", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "envfile-home-no-redirect.json");
    const realHome = await makeHomeWithGlobalEnv({ MARKER: "real" });
    const fakeHome = await makeHomeWithGlobalEnv({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      HOME: fakeHome,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  HOME: process.env.HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        HOME: realHome,
        XDG_CONFIG_HOME: undefined as unknown as string,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      HOME: fakeHome,
      MARKER: "real",
    });
  });

  it("T-API-59f: CLI -e file does not redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "cli-envfile-xdg-no-redirect.json");
    const realConfig = await makeXdgConfigHome({ MARKER: "real" });
    const fakeConfig = await makeXdgConfigHome({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      XDG_CONFIG_HOME: fakeConfig,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const result = await runCLI(["run", "-e", "local.env", "-n", "1", "ralph"], {
      cwd: project.dir,
      env: { XDG_CONFIG_HOME: realConfig },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      XDG_CONFIG_HOME: fakeConfig,
      MARKER: "real",
    });
  });

  it("T-API-59g: CLI -e file does not redirect global env-file lookup via HOME fallback", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "cli-envfile-home-no-redirect.json");
    const realHome = await makeHomeWithGlobalEnv({ MARKER: "real" });
    const fakeHome = await makeHomeWithGlobalEnv({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      HOME: fakeHome,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  HOME: process.env.HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const result = await runCLI(["run", "-e", "local.env", "-n", "1", "ralph"], {
      cwd: project.dir,
      env: {
        HOME: realHome,
        XDG_CONFIG_HOME: undefined as unknown as string,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      HOME: fakeHome,
      MARKER: "real",
    });
  });

  it("T-API-59h: run() RunOptions.envFile does not redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-envfile-xdg-no-redirect.json");
    const realConfig = await makeXdgConfigHome({ MARKER: "real" });
    const fakeConfig = await makeXdgConfigHome({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      XDG_CONFIG_HOME: fakeConfig,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { XDG_CONFIG_HOME: realConfig },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      XDG_CONFIG_HOME: fakeConfig,
      MARKER: "real",
    });
  });

  it("T-API-59i: run() RunOptions.envFile does not redirect global env-file lookup via HOME fallback", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-envfile-home-no-redirect.json");
    const realHome = await makeHomeWithGlobalEnv({ MARKER: "real" });
    const fakeHome = await makeHomeWithGlobalEnv({ MARKER: "fake" });
    await createEnvFile(join(project.dir, "local.env"), {
      HOME: fakeHome,
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  HOME: process.env.HOME,
  MARKER: process.env.MARKER,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        HOME: realHome,
        XDG_CONFIG_HOME: undefined as unknown as string,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      HOME: fakeHome,
      MARKER: "real",
    });
  });

  it("T-API-60: RunOptions.env TMPDIR does not redirect tmpdir parent selection under runPromise()", async () => {
    project = await createTempProject();
    const realParent = await makeTmpParent();
    const fakeParent = join(tmpdir(), `loopx-api-fake-parent-${randomUUID()}`);
    const marker = join(project.dir, "tmpdir-parent-promise.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  TMPDIR: process.env.TMPDIR,
  LOOPX_TMPDIR: process.env.LOOPX_TMPDIR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { TMPDIR: ${JSON.stringify(fakeParent)} },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: realParent },
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.TMPDIR).toBe(fakeParent);
    expect(observed.LOOPX_TMPDIR).toMatch(/^\/.*\/loopx-/);
    expect(observed.LOOPX_TMPDIR.startsWith(`${realParent}/loopx-`)).toBe(true);
  });

  it("T-API-60a: RunOptions.env TMPDIR does not redirect tmpdir parent selection under run()", async () => {
    project = await createTempProject();
    const realParent = await makeTmpParent();
    const fakeParent = join(tmpdir(), `loopx-api-fake-parent-${randomUUID()}`);
    const marker = join(project.dir, "tmpdir-parent-run.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  TMPDIR: process.env.TMPDIR,
  LOOPX_TMPDIR: process.env.LOOPX_TMPDIR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { TMPDIR: ${JSON.stringify(fakeParent)} },
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: realParent },
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.TMPDIR).toBe(fakeParent);
    expect(observed.LOOPX_TMPDIR).toMatch(/^\/.*\/loopx-/);
    expect(observed.LOOPX_TMPDIR.startsWith(`${realParent}/loopx-`)).toBe(true);
  });

  it("T-API-60b: run() RunOptions.env TEMP does not redirect tmpdir parent selection", async () => {
    project = await createTempProject();
    const rightParent = await makeTmpParent("loopx-api-temp-parent-");
    const wrongParent = join(tmpdir(), `loopx-api-wrong-temp-${randomUUID()}`);
    const marker = join(project.dir, "tmpdir-parent-temp-run.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  TEMP: process.env.TEMP,
  LOOPX_TMPDIR: process.env.LOOPX_TMPDIR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "loopx";
const expectedParent = tmpdir();
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { TEMP: ${JSON.stringify(wrongParent)} },
  maxIterations: 1,
})) {}
writeFileSync(${JSON.stringify(join(project.dir, "tmpdir-parent-temp-expected.txt"))}, expectedParent);
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        TMPDIR: undefined as unknown as string,
        TMP: undefined as unknown as string,
        TEMP: rightParent,
      },
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    const expectedParent = readFileSync(
      join(project.dir, "tmpdir-parent-temp-expected.txt"),
      "utf-8",
    );
    expect(observed.TEMP).toBe(wrongParent);
    expect(observed.LOOPX_TMPDIR).toMatch(/^\/.*\/loopx-/);
    expect(observed.LOOPX_TMPDIR.startsWith(`${expectedParent}/loopx-`)).toBe(true);
  });

  it("T-API-60c: run() RunOptions.env TMP does not redirect tmpdir parent selection", async () => {
    project = await createTempProject();
    const rightParent = await makeTmpParent("loopx-api-tmp-parent-");
    const wrongParent = join(tmpdir(), `loopx-api-wrong-tmp-${randomUUID()}`);
    const marker = join(project.dir, "tmpdir-parent-tmp-run.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  TMP: process.env.TMP,
  LOOPX_TMPDIR: process.env.LOOPX_TMPDIR,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "loopx";
const expectedParent = tmpdir();
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { TMP: ${JSON.stringify(wrongParent)} },
  maxIterations: 1,
})) {}
writeFileSync(${JSON.stringify(join(project.dir, "tmpdir-parent-tmp-expected.txt"))}, expectedParent);
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: {
        TMPDIR: undefined as unknown as string,
        TEMP: undefined as unknown as string,
        TMP: rightParent,
      },
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    const expectedParent = readFileSync(
      join(project.dir, "tmpdir-parent-tmp-expected.txt"),
      "utf-8",
    );
    expect(observed.TMP).toBe(wrongParent);
    expect(observed.LOOPX_TMPDIR).toMatch(/^\/.*\/loopx-/);
    expect(observed.LOOPX_TMPDIR.startsWith(`${expectedParent}/loopx-`)).toBe(true);
  });

  it("T-API-58a: RunOptions.env LOOPX_DELEGATED reaches spawned scripts under runPromise()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "delegated-options-promise.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
const val = process.env.LOOPX_DELEGATED;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(
  val === undefined ? { present: false } : { present: true, value: val }
));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_DELEGATED: "user-supplied" },
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { LOOPX_DELEGATED: undefined as unknown as string },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      present: true,
      value: "user-supplied",
    });
  });

  it("T-API-58a2: RunOptions.env LOOPX_DELEGATED reaches spawned scripts under run()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "delegated-options-run.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
const val = process.env.LOOPX_DELEGATED;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(
  val === undefined ? { present: false } : { present: true, value: val }
));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_DELEGATED: "user-supplied" },
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { LOOPX_DELEGATED: undefined as unknown as string },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      present: true,
      value: "user-supplied",
    });
  });

  it("T-API-58a3: RunOptions.envFile LOOPX_DELEGATED reaches spawned scripts under runPromise()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "delegated-envfile-promise.json");
    await createEnvFile(join(project.dir, "local.env"), {
      LOOPX_DELEGATED: "from-envfile",
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
const val = process.env.LOOPX_DELEGATED;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(
  val === undefined ? { present: false } : { present: true, value: val }
));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
});
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { LOOPX_DELEGATED: undefined as unknown as string },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      present: true,
      value: "from-envfile",
    });
  });

  it("T-API-58a4: RunOptions.envFile LOOPX_DELEGATED reaches spawned scripts under run()", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "delegated-envfile-run.json");
    await createEnvFile(join(project.dir, "local.env"), {
      LOOPX_DELEGATED: "from-envfile",
    });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
const val = process.env.LOOPX_DELEGATED;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(
  val === undefined ? { present: false } : { present: true, value: val }
));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: "local.env",
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { LOOPX_DELEGATED: undefined as unknown as string },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      present: true,
      value: "from-envfile",
    });
  });

  it("T-API-55e: invalid RunOptions wrapper rejects on both API surfaces before spawn", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-invalid-wrapper-");
    const marker = join(project.dir, "invalid-wrapper-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const variants = [
  ["null", null],
  ["array", []],
  ["function", function badOptions() {}],
];
const results = [];
for (const [label, options] of variants) {
  let runSyncThrow = false;
  let runRejected = false;
  try {
    const gen = run("ralph", options);
    try {
      await gen.next();
    } catch {
      runRejected = true;
    }
  } catch {
    runSyncThrow = true;
  }

  let promiseSyncThrow = false;
  let promiseRejected = false;
  try {
    const p = runPromise("ralph", options);
    try {
      await p;
    } catch {
      promiseRejected = true;
    }
  } catch {
    promiseSyncThrow = true;
  }
  results.push({ label, runSyncThrow, runRejected, promiseSyncThrow, promiseRejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        runSyncThrow: false,
        runRejected: true,
        promiseSyncThrow: false,
        promiseRejected: true,
      });
    }
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-55f: invalid RunOptions.signal rejects under maxIterations: 0 on both API surfaces", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-invalid-signal-");
    const marker = join(project.dir, "invalid-signal-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const variants = [
  ["string", "not-a-signal"],
  ["number", 42],
  ["missing-add", { aborted: false }],
  ["missing-aborted", { addEventListener() {} }],
  ["non-callable-add", { aborted: false, addEventListener: "nope" }],
  ["throwing-add", { aborted: false, addEventListener() { throw new Error("addEventListener boom"); } }],
];
const results = [];
for (const [label, signal] of variants) {
  let runRejected = false;
  try {
    const gen = run("ralph", { maxIterations: 0, signal });
    await gen.next();
  } catch {
    runRejected = true;
  }

  let promiseRejected = false;
  try {
    await runPromise("ralph", { maxIterations: 0, signal });
  } catch {
    promiseRejected = true;
  }
  results.push({ label, runRejected, promiseRejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        runRejected: true,
        promiseRejected: true,
      });
    }
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-55g: non-string cwd and envFile reject under maxIterations: 0 on both API surfaces", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-invalid-path-fields-");
    const marker = join(project.dir, "invalid-path-fields-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const invalidValues = [
  ["number", 42],
  ["boolean", true],
  ["object", {}],
  ["array", []],
  ["function", function badField() {}],
  ["null", null],
];
const results = [];
for (const field of ["cwd", "envFile"]) {
  for (const [label, value] of invalidValues) {
    const options = { maxIterations: 0, [field]: value };
    let runRejected = false;
    try {
      const gen = run("ralph", options);
      await gen.next();
    } catch {
      runRejected = true;
    }

    let promiseRejected = false;
    try {
      await runPromise("ralph", options);
    } catch {
      promiseRejected = true;
    }
    results.push({ field, label, runRejected, promiseRejected });
  }
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        runRejected: true,
        promiseRejected: true,
      });
    }
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-55h: throwing cwd and envFile getters reject under maxIterations: 0 on both API surfaces", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-throwing-path-getters-");
    const marker = join(project.dir, "throwing-path-getters-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
function makeOptions(field) {
  const options = { maxIterations: 0 };
  Object.defineProperty(options, field, {
    enumerable: true,
    get() {
      throw new Error(field + "-getter-boom");
    },
  });
  return options;
}

const results = [];
for (const field of ["cwd", "envFile"]) {
  let runRejected = false;
  try {
    const gen = run("ralph", makeOptions(field));
    await gen.next();
  } catch (error) {
    runRejected = String(error?.message ?? error).includes(field + "-getter-boom");
  }

  let promiseRejected = false;
  try {
    await runPromise("ralph", makeOptions(field));
  } catch (error) {
    promiseRejected = String(error?.message ?? error).includes(field + "-getter-boom");
  }
  results.push({ field, runRejected, promiseRejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { field: "cwd", runRejected: true, promiseRejected: true },
      { field: "envFile", runRejected: true, promiseRejected: true },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-57/T-API-57a: NUL in RunOptions.env key or value rejects as spawn failure under runPromise()", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-nul-parent-");
    const marker = join(project.dir, "nul-env-promise-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const variants = [
  ["T-API-57", { MYVAR: "bad\\u0000val" }],
  ["T-API-57a", { ["BAD\\u0000KEY"]: "val" }],
];
const results = [];
for (const [id, env] of variants) {
  let rejected = false;
  try {
    await runPromise("ralph", {
      cwd: ${JSON.stringify(project.dir)},
      env,
      maxIterations: 1,
    });
  } catch {
    rejected = true;
  }
  results.push({ id, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "T-API-57", rejected: true },
      { id: "T-API-57a", rejected: true },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-57h/T-API-57i: NUL in RunOptions.env key or value rejects as spawn failure under run()", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-nul-run-parent-");
    const marker = join(project.dir, "nul-env-run-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run } from "loopx";
const variants = [
  ["T-API-57h", { MYVAR: "bad\\u0000val" }],
  ["T-API-57i", { ["BAD\\u0000KEY"]: "val" }],
];
const results = [];
for (const [id, env] of variants) {
  let rejected = false;
  try {
    const gen = run("ralph", {
      cwd: ${JSON.stringify(project.dir)},
      env,
      maxIterations: 1,
    });
    await gen.next();
  } catch {
    rejected = true;
  }
  results.push({ id, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "T-API-57h", rejected: true },
      { id: "T-API-57i", rejected: true },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-57d/T-API-57e: NUL RunOptions.env entries survive maxIterations: 0 under runPromise()", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-nul-zero-parent-");
    const marker = join(project.dir, "nul-zero-promise-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const variants = [
  ["T-API-57d", { MYVAR: "bad\\u0000val" }],
  ["T-API-57e", { ["BAD\\u0000KEY"]: "val" }],
];
const results = [];
for (const [id, env] of variants) {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 0,
  });
  results.push({ id, outputs });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "T-API-57d", outputs: [] },
      { id: "T-API-57e", outputs: [] },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-57f/T-API-57f2: NUL RunOptions.env entries survive maxIterations: 0 under run()", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent("loopx-api-nul-zero-run-parent-");
    const marker = join(project.dir, "nul-zero-run-should-not-run.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run } from "loopx";
const variants = [
  ["T-API-57f", { MYVAR: "bad\\u0000val" }],
  ["T-API-57f2", { ["BAD\\u0000KEY"]: "val" }],
];
const results = [];
for (const [id, env] of variants) {
  const gen = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 0,
  });
  const first = await gen.next();
  results.push({ id, done: first.done, value: first.value });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "T-API-57f", done: true },
      { id: "T-API-57f2", done: true },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-57g/T-API-57g2: non-POSIX RunOptions.env names reach spawned scripts on both API surfaces", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "non-posix-env-names.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : [];
previous.push({
  "1BAD": process.env["1BAD"],
  "FOO-BAR": process.env["FOO-BAR"],
});
writeFileSync(marker, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const env = {
  "1BAD": "ok-digit-prefix",
  "FOO-BAR": "ok-dash-interior",
};
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
})) {}
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      { "1BAD": "ok-digit-prefix", "FOO-BAR": "ok-dash-interior" },
      { "1BAD": "ok-digit-prefix", "FOO-BAR": "ok-dash-interior" },
    ]);
  });
});
