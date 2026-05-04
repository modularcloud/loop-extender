export interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}

export interface RunOptions {
  maxIterations?: number;
  envFile?: string;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
}
