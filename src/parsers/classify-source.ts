export interface ClassifyResult {
  type: "git" | "tarball" | "single-file";
  url: string;
}

const KNOWN_GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

/**
 * Classify an install source into its type.
 *
 * Rules (Spec 10.1), applied in order:
 * 1. org/repo shorthand -> git (expanded to github URL); reject if repo ends in .git
 * 2. Known git hosts with /<owner>/<repo>[.git][/] pathname -> git
 * 3. URL ending in .git -> git
 * 4. URL pathname ending in .tar.gz or .tgz -> tarball
 * 5. Everything else -> single-file
 */
export function classifySource(source: string): ClassifyResult {
  // Rule 1: org/repo shorthand
  // No protocol prefix, no git@ prefix, exactly one slash
  if (!source.includes("://") && !source.startsWith("git@")) {
    const parts = source.split("/");
    if (
      parts.length === 2 &&
      parts[0] &&
      parts[1] &&
      !parts[1].endsWith(".git")
    ) {
      return {
        type: "git",
        url: `https://github.com/${parts[0]}/${parts[1]}.git`,
      };
    }
  }

  // Handle SCP-like SSH URLs (git@host:path)
  // These are not valid URLs for the URL constructor
  if (source.startsWith("git@")) {
    return { type: "git", url: source };
  }

  // Parse as URL
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { type: "single-file", url: source };
  }

  const pathname = url.pathname;

  // Rule 2: Known git hosts with /<owner>/<repo>[.git][/]
  if (KNOWN_GIT_HOSTS.includes(url.hostname)) {
    const cleanPath = pathname.replace(/\/$/, ""); // strip trailing slash
    const segments = cleanPath.split("/").filter(Boolean);
    if (segments.length === 2) {
      return { type: "git", url: source };
    }
  }

  // Rule 3: URL ending in .git
  if (pathname.endsWith(".git") || pathname.endsWith(".git/")) {
    return { type: "git", url: source };
  }

  // Rule 4: Tarball URL (pathname ending in .tar.gz or .tgz)
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) {
    return { type: "tarball", url: source };
  }

  // Rule 5: Everything else is single-file
  return { type: "single-file", url: source };
}
