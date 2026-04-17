// Minimal semver range checker supporting the subset used by loopx:
//   - exact versions: "1.2.3"
//   - wildcard: "*", "x", "X"
//   - caret: "^1.2.3"
//   - tilde: "~1.2.3"
//   - comparators: ">=1.2.3", ">1.2.3", "<=1.2.3", "<1.2.3", "=1.2.3"
//   - compound AND: ">=1.0.0 <2.0.0"
//   - compound OR: "1.0.0 || 2.0.0"
//   - prerelease: "1.2.3-alpha.1" (compared per semver ordering)
//
// Designed for workflow package.json `loopx` range validation (SPEC §3.2).

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[]; // e.g., ["alpha", 1]
  // build metadata is ignored for comparison
}

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): ParsedVersion | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  const [, majorS, minorS, patchS, prereleaseS] = m;
  return {
    major: Number(majorS),
    minor: Number(minorS),
    patch: Number(patchS),
    prerelease: prereleaseS ? prereleaseS.split(".") : [],
  };
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdent(a: string, b: string): number {
  const aIsNum = /^\d+$/.test(a);
  const bIsNum = /^\d+$/.test(b);
  if (aIsNum && bIsNum) return compareNumbers(Number(a), Number(b));
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const byMajor = compareNumbers(a.major, b.major);
  if (byMajor !== 0) return byMajor;
  const byMinor = compareNumbers(a.minor, b.minor);
  if (byMinor !== 0) return byMinor;
  const byPatch = compareNumbers(a.patch, b.patch);
  if (byPatch !== 0) return byPatch;

  // Prerelease: a version with a prerelease has lower precedence than one
  // without. Two prereleases compare identifier-by-identifier.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const c = comparePrereleaseIdent(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}

interface Comparator {
  op: ">" | ">=" | "<" | "<=" | "=";
  version: ParsedVersion;
}

function parseComparator(raw: string): Comparator[] | null {
  const s = raw.trim();
  if (s === "" || s === "*" || s === "x" || s === "X") {
    // match-any: use a single ">=0.0.0" comparator with prerelease allowance
    return [{ op: ">=", version: { major: 0, minor: 0, patch: 0, prerelease: [] } }];
  }

  // Caret range: ^1.2.3 → >=1.2.3 <2.0.0 (for major >= 1)
  //              ^0.2.3 → >=0.2.3 <0.3.0
  //              ^0.0.3 → >=0.0.3 <0.0.4
  if (s.startsWith("^")) {
    const v = parseVersion(s.slice(1));
    if (!v) return null;
    let upperMajor = v.major;
    let upperMinor = v.minor;
    let upperPatch = v.patch;
    if (v.major > 0) {
      upperMajor = v.major + 1;
      upperMinor = 0;
      upperPatch = 0;
    } else if (v.minor > 0) {
      upperMinor = v.minor + 1;
      upperPatch = 0;
    } else {
      upperPatch = v.patch + 1;
    }
    return [
      { op: ">=", version: v },
      {
        op: "<",
        version: {
          major: upperMajor,
          minor: upperMinor,
          patch: upperPatch,
          prerelease: [],
        },
      },
    ];
  }

  // Tilde range: ~1.2.3 → >=1.2.3 <1.3.0
  //              ~1.2 → >=1.2.0 <1.3.0 (unsupported here; needs full spec)
  if (s.startsWith("~")) {
    const v = parseVersion(s.slice(1));
    if (!v) return null;
    return [
      { op: ">=", version: v },
      {
        op: "<",
        version: {
          major: v.major,
          minor: v.minor + 1,
          patch: 0,
          prerelease: [],
        },
      },
    ];
  }

  // Comparators: >=, >, <=, <, =
  const opMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(s);
  if (opMatch) {
    const op = opMatch[1] as Comparator["op"];
    const v = parseVersion(opMatch[2]);
    if (!v) return null;
    return [{ op, version: v }];
  }

  // Bare exact version
  const v = parseVersion(s);
  if (!v) return null;
  return [{ op: "=", version: v }];
}

// A range is a set of OR-groups; each group is an AND of comparators.
type RangeExpr = Comparator[][];

function parseRange(range: string): RangeExpr | null {
  const orGroups = range.split("||").map((g) => g.trim());
  const result: RangeExpr = [];
  for (const group of orGroups) {
    if (group === "") return null;
    // AND-combine whitespace-separated comparators
    const tokens = group.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    const comps: Comparator[] = [];
    for (const t of tokens) {
      const parsed = parseComparator(t);
      if (!parsed) return null;
      comps.push(...parsed);
    }
    result.push(comps);
  }
  return result.length > 0 ? result : null;
}

function evalComparator(cmp: Comparator, v: ParsedVersion): boolean {
  const c = compareVersions(v, cmp.version);
  switch (cmp.op) {
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case "=":
      return c === 0;
  }
}

export function isValidRange(range: string): boolean {
  if (typeof range !== "string") return false;
  return parseRange(range) !== null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const expr = parseRange(range);
  if (!expr) return false;
  for (const group of expr) {
    let allOk = true;
    for (const cmp of group) {
      if (!evalComparator(cmp, v)) {
        allOk = false;
        break;
      }
    }
    if (allOk) return true;
  }
  return false;
}
