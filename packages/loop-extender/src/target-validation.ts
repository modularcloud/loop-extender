// Parse and validate target strings per SPEC §4.1 and §2.2.
//
// A target string identifies a workflow and optional script:
//   "ralph"            → workflow=ralph, script=null (default to index)
//   "ralph:check"      → workflow=ralph, script=check
//   "ralph:index"      → workflow=ralph, script=index
//
// Invalid target strings (both for CLI/API targets and goto values):
//   ""      empty
//   ":"     bare colon
//   ":x"    leading colon
//   "x:"    trailing colon
//   "a:b:c" multiple colons
//   name-restriction violations in either portion

export const NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export type TargetParse =
  | { ok: true; workflow: string; script: string | null }
  | { ok: false; error: string };

export function parseTarget(target: string): TargetParse {
  if (typeof target !== "string") {
    return { ok: false, error: `Invalid target: must be a string, got ${typeof target}` };
  }
  if (target === "") {
    return { ok: false, error: "Invalid target: target string is empty" };
  }
  if (target === ":") {
    return { ok: false, error: "Invalid target: ':' is not a valid target" };
  }

  const parts = target.split(":");
  if (parts.length > 2) {
    return {
      ok: false,
      error: `Invalid target '${target}': only one ':' delimiter is allowed`,
    };
  }

  if (parts.length === 1) {
    const wf = parts[0];
    if (!NAME_PATTERN.test(wf)) {
      return {
        ok: false,
        error: `Invalid target '${target}': workflow name must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
      };
    }
    return { ok: true, workflow: wf, script: null };
  }

  const [wf, script] = parts;
  if (wf === "") {
    return {
      ok: false,
      error: `Invalid target '${target}': leading ':' (empty workflow)`,
    };
  }
  if (script === "") {
    return {
      ok: false,
      error: `Invalid target '${target}': trailing ':' (empty script)`,
    };
  }
  if (!NAME_PATTERN.test(wf)) {
    return {
      ok: false,
      error: `Invalid target '${target}': workflow name '${wf}' must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
    };
  }
  if (!NAME_PATTERN.test(script)) {
    return {
      ok: false,
      error: `Invalid target '${target}': script name '${script}' must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
    };
  }
  return { ok: true, workflow: wf, script };
}

// Parse a goto target. Bare names resolve to scripts in the current workflow.
// Semantics (SPEC §2.2):
//   bare "check-ready" → current-workflow:check-ready (script in current workflow)
//   qualified "foo:bar" → foo:bar
//
// Validation rules are the same as parseTarget, with one addition: a bare
// name in goto is a *script name*, not a workflow name (the caller knows
// which workflow to use).
export type GotoParse =
  | { ok: true; kind: "bare"; script: string }
  | { ok: true; kind: "qualified"; workflow: string; script: string }
  | { ok: false; error: string };

export function parseGoto(goto: string): GotoParse {
  if (typeof goto !== "string") {
    return { ok: false, error: `Invalid goto: must be a string, got ${typeof goto}` };
  }
  if (goto === "") {
    return { ok: false, error: "Invalid goto: target string is empty" };
  }
  if (goto === ":") {
    return { ok: false, error: "Invalid goto: ':' is not a valid target" };
  }

  const parts = goto.split(":");
  if (parts.length > 2) {
    return {
      ok: false,
      error: `Invalid goto '${goto}': only one ':' delimiter is allowed`,
    };
  }

  if (parts.length === 1) {
    const name = parts[0];
    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `Invalid goto '${goto}': script name must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
      };
    }
    return { ok: true, kind: "bare", script: name };
  }

  const [wf, script] = parts;
  if (wf === "") {
    return {
      ok: false,
      error: `Invalid goto '${goto}': leading ':' (empty workflow)`,
    };
  }
  if (script === "") {
    return {
      ok: false,
      error: `Invalid goto '${goto}': trailing ':' (empty script)`,
    };
  }
  if (!NAME_PATTERN.test(wf)) {
    return {
      ok: false,
      error: `Invalid goto '${goto}': workflow name '${wf}' must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
    };
  }
  if (!NAME_PATTERN.test(script)) {
    return {
      ok: false,
      error: `Invalid goto '${goto}': script name '${script}' must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
    };
  }
  return { ok: true, kind: "qualified", workflow: wf, script };
}
