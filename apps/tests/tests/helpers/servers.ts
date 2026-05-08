import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface HTTPRoute {
  path: string;
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body: string | Buffer;
  handler?: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface HTTPServer {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/**
 * Starts a lightweight local HTTP server serving the specified routes.
 */
export async function startLocalHTTPServer(
  routes: HTTPRoute[]
): Promise<HTTPServer> {
  const routeMap = new Map<string, HTTPRoute>();
  for (const route of routes) {
    routeMap.set(route.path, route);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = urlObj.pathname;
    requests.push(req.url ?? pathname);

    // Try exact path match first, then path with query string
    const route = routeMap.get(pathname) ?? routeMap.get(req.url ?? "/");

    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (route.handler) {
      route.handler(req, res);
      return;
    }

    const status = route.status ?? 200;
    const headers = {
      "Content-Type": route.contentType ?? "application/octet-stream",
      ...route.headers,
    };
    res.writeHead(status, headers);
    res.end(route.body);
  });

  const requests: string[] = [];

  return new Promise<HTTPServer>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        requests,
        async close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });

    server.on("error", reject);
  });
}

export interface GitServerRepo {
  name: string;
  files: Record<string, string>;
}

export interface GitServer {
  /** Base path for file:// URLs. Get a repo URL with `${url}/${repoName}.git` */
  url: string;
  close(): Promise<void>;
}

/**
 * Creates local bare git repos served via file:// URLs.
 */
export async function startLocalGitServer(
  repos: GitServerRepo[]
): Promise<GitServer> {
  const baseDir = await mkdtemp(join(tmpdir(), "loopx-git-"));

  for (const repo of repos) {
    const bareDir = join(baseDir, `${repo.name}.git`);
    const workDir = join(baseDir, `${repo.name}-work`);

    // Create bare repo
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

    // Clone, add files, commit, push
    execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });

    for (const [filePath, content] of Object.entries(repo.files)) {
      const fullPath = join(workDir, filePath);
      const dir = join(fullPath, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }

    execSync(
      `cd "${workDir}" && git add -A && git -c user.email="test@test.com" -c user.name="Test" commit -m "initial"`,
      { stdio: "pipe" }
    );
    execSync(`cd "${workDir}" && git push origin HEAD`, { stdio: "pipe" });
  }

  return {
    url: `file://${baseDir}`,
    async close() {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Sets up isolated git config with url.<base>.insteadOf rules
 * for rewriting known-host URLs to local file:// repos.
 */
export async function withGitURLRewrite(
  rewrites: Record<string, string>,
  fn: () => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "loopx-gitconfig-"));
  const gitConfigPath = join(tempDir, "gitconfig");

  // Write git config with insteadOf rules
  let config = "";
  for (const [from, to] of Object.entries(rewrites)) {
    config += `[url "${to}"]\n\tinsteadOf = ${from}\n`;
  }
  await writeFile(gitConfigPath, config, "utf-8");

  const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const originalHome = process.env.HOME;
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  // Isolate HOME so that user-level git config (~/.gitconfig) cannot interfere
  process.env.HOME = tempDir;

  try {
    await fn();
  } finally {
    if (originalGitConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
