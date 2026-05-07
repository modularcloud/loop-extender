export interface ClassifyResult {
  type: "git" | "tarball";
  url: string;
}

const KNOWN_GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

/**
 * Classify an install source per SPEC §10.1 (post-ADR-0003).
 *
 * Rules, applied in order:
 *   1. `org/repo` shorthand — expanded to https://github.com/org/repo.git as
 *      a git source. Rejects `org/repo.git` (full URL required in that case).
 *   2. Known git hosts (github.com / gitlab.com / bitbucket.org) with
 *      pathname `/<owner>/<repo>` or `/<owner>/<repo>.git` (optionally with
 *      trailing slash) — git.
 *   3. Any other URL ending in `.git` — git.
 *   4. URL pathname (ignoring query/fragment) ending in `.tar.gz` or `.tgz`
 *      — tarball.
 *   5. Everything else — rejected with an error. Single-file URL install is
 *      no longer supported.
 *
 * Returns a result or throws an Error whose message describes the rejection.
 */
export function classifySource(source: string): ClassifyResult {
  // Rule 1: org/repo shorthand
  if (!source.includes("://") && !source.startsWith("git@")) {
    const parts = source.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      if (parts[1].endsWith(".git")) {
        throw new Error(
          `org/repo.git shorthand is not supported. Use the full URL: https://github.com/${parts[0]}/${parts[1]}`
        );
      }
      return {
        type: "git",
        url: `https://github.com/${parts[0]}/${parts[1]}.git`,
      };
    }
  }

  // SCP-like SSH URLs (git@host:path)
  if (source.startsWith("git@")) {
    return { type: "git", url: source };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      `Unsupported install source: '${source}'. Expected org/repo shorthand, git URL, or tarball URL (.tar.gz / .tgz).`
    );
  }

  const pathname = url.pathname;

  // Rule 2: known git hosts with /<owner>/<repo>[.git][/]
  if (KNOWN_GIT_HOSTS.includes(url.hostname)) {
    const cleanPath = pathname.replace(/\/$/, "");
    const segments = cleanPath.split("/").filter(Boolean);
    if (segments.length === 2) {
      url.hash = "";
      return { type: "git", url: url.toString() };
    }
  }

  // Rule 3: URL ending in .git
  if (pathname.endsWith(".git")) {
    return { type: "git", url: source };
  }

  // Rule 4: tarball URL
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) {
    return { type: "tarball", url: source };
  }

  // Rule 5: anything else is rejected
  throw new Error(
    `Unsupported install source: '${source}'. Single-file URL install is not supported; workflows must be installed from a git repository or tarball.`
  );
}
