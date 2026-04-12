import { describe, it, expect } from "vitest";
import { classifySource } from "loopx/internal";

/**
 * TEST-SPEC §6.3 — Unit tests for classifySource internal seam.
 *
 * classifySource(source: string) => { type: "git" | "tarball" | "single-file", url: string }
 *
 * Source detection rules (Spec 10.1), applied in order:
 * 1. org/repo shorthand → https://github.com/org/repo.git (git)
 * 2. Known git hosts (github.com, gitlab.com, bitbucket.org) with /<owner>/<repo>[.git][/] → git
 * 3. URL ending in .git → git
 * 4. URL pathname ending in .tar.gz or .tgz → tarball
 * 5. Any other URL → single-file
 */

describe("SPEC: classifySource — org/repo Shorthand", () => {
  it("org/repo → git with expanded github URL", () => {
    const result = classifySource("org/repo");
    expect(result).toEqual({
      type: "git",
      url: "https://github.com/org/repo.git",
    });
  });

  it("myorg/my-agent-script → git with expanded github URL", () => {
    const result = classifySource("myorg/my-agent-script");
    expect(result).toEqual({
      type: "git",
      url: "https://github.com/myorg/my-agent-script.git",
    });
  });

  it("org with hyphens and underscores / repo with hyphens", () => {
    const result = classifySource("my-org_name/my-repo");
    expect(result).toEqual({
      type: "git",
      url: "https://github.com/my-org_name/my-repo.git",
    });
  });
});

describe("SPEC: classifySource — Known Git Hosts (github.com)", () => {
  it("https://github.com/org/repo → git", () => {
    const result = classifySource("https://github.com/org/repo");
    expect(result.type).toBe("git");
    expect(result.url).toBe("https://github.com/org/repo");
  });

  it("https://github.com/org/repo.git → git", () => {
    const result = classifySource("https://github.com/org/repo.git");
    expect(result.type).toBe("git");
    expect(result.url).toBe("https://github.com/org/repo.git");
  });

  it("https://github.com/org/repo/ (trailing slash) → git", () => {
    const result = classifySource("https://github.com/org/repo/");
    expect(result.type).toBe("git");
  });

  it("https://github.com/org/repo.git/ (trailing slash after .git) → git", () => {
    const result = classifySource("https://github.com/org/repo.git/");
    expect(result.type).toBe("git");
  });
});

describe("SPEC: classifySource — Known Git Hosts (gitlab.com)", () => {
  it("https://gitlab.com/org/repo → git", () => {
    const result = classifySource("https://gitlab.com/org/repo");
    expect(result.type).toBe("git");
  });

  it("https://gitlab.com/org/repo.git → git", () => {
    const result = classifySource("https://gitlab.com/org/repo.git");
    expect(result.type).toBe("git");
  });
});

describe("SPEC: classifySource — Known Git Hosts (bitbucket.org)", () => {
  it("https://bitbucket.org/org/repo → git", () => {
    const result = classifySource("https://bitbucket.org/org/repo");
    expect(result.type).toBe("git");
  });

  it("https://bitbucket.org/org/repo.git → git", () => {
    const result = classifySource("https://bitbucket.org/org/repo.git");
    expect(result.type).toBe("git");
  });
});

// SSH/SCP URL tests intentionally omitted per SP-32 (pending spec decision).
// See TEST-SPEC.md section 9: "No tests are added for this behavior until
// the spec ambiguity is resolved."

describe("SPEC: classifySource — Generic .git URLs", () => {
  it("https://example.com/some/path/repo.git → git", () => {
    const result = classifySource("https://example.com/some/path/repo.git");
    expect(result.type).toBe("git");
  });

  it("https://self-hosted.dev/myrepo.git → git", () => {
    const result = classifySource("https://self-hosted.dev/myrepo.git");
    expect(result.type).toBe("git");
  });
});

describe("SPEC: classifySource — Tarball URLs", () => {
  it("https://example.com/archive.tar.gz → tarball", () => {
    const result = classifySource("https://example.com/archive.tar.gz");
    expect(result.type).toBe("tarball");
    expect(result.url).toBe("https://example.com/archive.tar.gz");
  });

  it("https://example.com/archive.tgz → tarball", () => {
    const result = classifySource("https://example.com/archive.tgz");
    expect(result.type).toBe("tarball");
    expect(result.url).toBe("https://example.com/archive.tgz");
  });

  it("https://example.com/path/to/release-v1.0.tar.gz → tarball", () => {
    const result = classifySource(
      "https://example.com/path/to/release-v1.0.tar.gz"
    );
    expect(result.type).toBe("tarball");
  });

  it("tarball URL with query string → still detected as tarball (pathname is checked)", () => {
    const result = classifySource(
      "https://example.com/archive.tar.gz?token=abc123"
    );
    expect(result.type).toBe("tarball");
  });

  it("tarball URL with fragment → still detected as tarball", () => {
    const result = classifySource(
      "https://example.com/archive.tgz#sha256=abc"
    );
    expect(result.type).toBe("tarball");
  });
});

describe("SPEC: classifySource — Single-File URLs", () => {
  it("https://example.com/script.ts → single-file", () => {
    const result = classifySource("https://example.com/script.ts");
    expect(result.type).toBe("single-file");
    expect(result.url).toBe("https://example.com/script.ts");
  });

  it("https://example.com/script.sh → single-file", () => {
    const result = classifySource("https://example.com/script.sh");
    expect(result.type).toBe("single-file");
  });

  it("https://example.com/script.js → single-file", () => {
    const result = classifySource("https://example.com/script.js");
    expect(result.type).toBe("single-file");
  });

  it("https://example.com/path/to/script.tsx → single-file", () => {
    const result = classifySource("https://example.com/path/to/script.tsx");
    expect(result.type).toBe("single-file");
  });

  it("https://example.com/script.jsx → single-file", () => {
    const result = classifySource("https://example.com/script.jsx");
    expect(result.type).toBe("single-file");
  });

  it("any other URL falls through to single-file", () => {
    const result = classifySource("https://example.com/something");
    expect(result.type).toBe("single-file");
  });
});

describe("SPEC: classifySource — URLs With Ports, Auth, Extra Path Segments", () => {
  it("URL with port → type detected correctly", () => {
    const result = classifySource("https://example.com:8443/script.ts");
    expect(result.type).toBe("single-file");
  });

  it("URL with port and tarball → tarball", () => {
    const result = classifySource("https://example.com:9090/archive.tar.gz");
    expect(result.type).toBe("tarball");
  });

  it("URL with auth info → type detected correctly", () => {
    const result = classifySource(
      "https://user:pass@example.com/script.ts"
    );
    expect(result.type).toBe("single-file");
  });

  it("URL with auth and .git suffix → git", () => {
    const result = classifySource(
      "https://user:token@example.com/repo.git"
    );
    expect(result.type).toBe("git");
  });

  it("known git host with extra path segments → not matched as git shorthand, falls through", () => {
    // Per spec 10.1 rule 2: known git hosts only match /<owner>/<repo>[.git][/]
    // Extra segments like /tree/main are not matched as git
    const result = classifySource(
      "https://github.com/org/repo/tree/main/script.ts"
    );
    // This is not /<owner>/<repo> pattern, so it falls through to single-file
    expect(result.type).toBe("single-file");
  });

  it("known git host with raw file URL → single-file (not git)", () => {
    const result = classifySource(
      "https://github.com/org/repo/raw/main/script.ts"
    );
    expect(result.type).toBe("single-file");
  });

  it("known git host with tarball download URL → tarball (not git)", () => {
    const result = classifySource(
      "https://github.com/org/repo/archive/refs/tags/v1.0.tar.gz"
    );
    expect(result.type).toBe("tarball");
  });
});

describe("SPEC: classifySource — URLs With Query Strings", () => {
  it("single-file URL with query → type detected, query not part of filename", () => {
    const result = classifySource(
      "https://example.com/script.ts?v=2&auth=token"
    );
    expect(result.type).toBe("single-file");
  });

  it("tarball URL with query → detected as tarball based on pathname", () => {
    const result = classifySource(
      "https://example.com/release.tar.gz?download=true"
    );
    expect(result.type).toBe("tarball");
  });

  it(".git URL with query → detected as git based on pathname", () => {
    const result = classifySource(
      "https://example.com/repo.git?ref=main"
    );
    expect(result.type).toBe("git");
  });

  it("URL where query string contains .tar.gz → not tarball (pathname checked, not full URL)", () => {
    // The pathname is /download, not ending in .tar.gz
    const result = classifySource(
      "https://example.com/download?file=archive.tar.gz"
    );
    expect(result.type).toBe("single-file");
  });
});

describe("SPEC: classifySource — Edge Cases", () => {
  it("trailing slash on single-file URL", () => {
    const result = classifySource("https://example.com/script.ts/");
    // Trailing slash means the last path segment is empty; this is an unusual case.
    // The URL should still be classified (likely as single-file since it doesn't match git/tarball patterns)
    expect(result.type).toBe("single-file");
  });

  it("double extension: .tar.gz is tarball, not .gz single-file", () => {
    const result = classifySource("https://example.com/file.tar.gz");
    expect(result.type).toBe("tarball");
  });

  it("URL ending in .gz (not .tar.gz) → single-file", () => {
    const result = classifySource("https://example.com/file.gz");
    expect(result.type).toBe("single-file");
  });

  it("URL ending in .tar (not .tar.gz or .tgz) → single-file", () => {
    const result = classifySource("https://example.com/file.tar");
    expect(result.type).toBe("single-file");
  });

  it("http:// (not https) URL → still classified correctly", () => {
    const result = classifySource("http://example.com/script.ts");
    expect(result.type).toBe("single-file");
  });

  it("http:// tarball URL → tarball", () => {
    const result = classifySource("http://example.com/archive.tgz");
    expect(result.type).toBe("tarball");
  });

  it("http:// git URL → git", () => {
    const result = classifySource("http://example.com/repo.git");
    expect(result.type).toBe("git");
  });
});
