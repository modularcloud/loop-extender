import { describe, it, expect } from "vitest";
import { classifySource } from "loopx/internal";

/**
 * TEST-SPEC §6.3 — Unit tests for classifySource internal seam.
 *
 * classifySource(source: string) => { type: "git" | "tarball", url: string }
 *
 * Source detection rules (Spec 10.1, post-ADR-0003), applied in order:
 * 1. org/repo shorthand → https://github.com/org/repo.git (git)
 * 2. Known git hosts (github.com, gitlab.com, bitbucket.org) with /<owner>/<repo>[.git][/] → git
 * 3. URL ending in .git → git
 * 4. URL pathname ending in .tar.gz or .tgz → tarball
 * 5. Any other URL → throws (single-file URL install removed)
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

describe("SPEC: classifySource — Single-File URLs Throw (ADR-0003)", () => {
  it("https://example.com/script.ts → throws", () => {
    expect(() => classifySource("https://example.com/script.ts")).toThrow();
  });

  it("https://example.com/script.sh → throws", () => {
    expect(() => classifySource("https://example.com/script.sh")).toThrow();
  });

  it("https://example.com/script.js → throws", () => {
    expect(() => classifySource("https://example.com/script.js")).toThrow();
  });

  it("https://example.com/path/to/script.tsx → throws", () => {
    expect(() =>
      classifySource("https://example.com/path/to/script.tsx")
    ).toThrow();
  });

  it("https://example.com/script.jsx → throws", () => {
    expect(() => classifySource("https://example.com/script.jsx")).toThrow();
  });

  it("any other URL → throws", () => {
    expect(() => classifySource("https://example.com/something")).toThrow();
  });
});

describe("SPEC: classifySource — URLs With Ports, Auth, Extra Path Segments", () => {
  it("URL with port + single-file-shaped pathname → throws", () => {
    expect(() =>
      classifySource("https://example.com:8443/script.ts")
    ).toThrow();
  });

  it("URL with port and tarball → tarball", () => {
    const result = classifySource("https://example.com:9090/archive.tar.gz");
    expect(result.type).toBe("tarball");
  });

  it("URL with auth info + single-file-shaped pathname → throws", () => {
    expect(() =>
      classifySource("https://user:pass@example.com/script.ts")
    ).toThrow();
  });

  it("URL with auth and .git suffix → git", () => {
    const result = classifySource(
      "https://user:token@example.com/repo.git"
    );
    expect(result.type).toBe("git");
  });

  it("known git host with extra path segments → throws (not single-file)", () => {
    // Per spec 10.1 rule 2: known git hosts only match /<owner>/<repo>[.git][/]
    // Extra segments like /tree/main do not match git shorthand;
    // post-ADR-0003, they also don't match tarball, so they throw.
    expect(() =>
      classifySource("https://github.com/org/repo/tree/main/script.ts")
    ).toThrow();
  });

  it("known git host with raw file URL → throws", () => {
    expect(() =>
      classifySource("https://github.com/org/repo/raw/main/script.ts")
    ).toThrow();
  });

  it("known git host with tarball download URL → tarball (not git)", () => {
    const result = classifySource(
      "https://github.com/org/repo/archive/refs/tags/v1.0.tar.gz"
    );
    expect(result.type).toBe("tarball");
  });
});

describe("SPEC: classifySource — URLs With Query Strings", () => {
  it("non-tarball URL with query → throws", () => {
    expect(() =>
      classifySource("https://example.com/script.ts?v=2&auth=token")
    ).toThrow();
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

  it("URL where query string contains .tar.gz but pathname does not → throws", () => {
    expect(() =>
      classifySource("https://example.com/download?file=archive.tar.gz")
    ).toThrow();
  });
});

describe("SPEC: classifySource — Edge Cases", () => {
  it("trailing slash on non-tarball/git URL → throws", () => {
    expect(() =>
      classifySource("https://example.com/script.ts/")
    ).toThrow();
  });

  it("double extension: .tar.gz is tarball, not .gz single-file", () => {
    const result = classifySource("https://example.com/file.tar.gz");
    expect(result.type).toBe("tarball");
  });

  it("URL ending in .gz (not .tar.gz) → throws", () => {
    expect(() => classifySource("https://example.com/file.gz")).toThrow();
  });

  it("URL ending in .tar (not .tar.gz or .tgz) → throws", () => {
    expect(() => classifySource("https://example.com/file.tar")).toThrow();
  });

  it("http:// (not https) URL pointing to script → throws", () => {
    expect(() => classifySource("http://example.com/script.ts")).toThrow();
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
