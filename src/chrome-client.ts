import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthConfig } from './auth';

const CDP_WAIT_TIMEOUT_MS = 12_000;
const BRIDGE_PATH = fileURLToPath(new URL('./cdp-bridge.mjs', import.meta.url));

export interface LaunchOptions {
  url?: string;
  newWindow?: boolean;
}

export interface OpenOptions {
  newWindow?: boolean;
}

export interface LaunchResult {
  pid: number | null;
  command: string;
  args: string[];
  cdpUrl: string;
  launched: boolean;
}

export interface ExecutableStatus {
  ok: boolean;
  command: string;
  versionOutput?: string;
  error?: string;
}

export interface GridRange {
  start: string;
  end: string;
}

export interface Zone {
  start: string;
  end: string;
}

export interface ElementInfo {
  kb: string;
  tag: string;
  text: string;
  placeholder?: string;
  type?: string;
  role?: string;
  label?: string;
}

export interface ZoneResult {
  zone: string;
  elements: ElementInfo[];
}

export type Action =
  | { type: 'click'; kb: string }
  | { type: 'type'; kb: string; text: string }
  | { type: 'select'; kb: string; value: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'navigate'; url: string };

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  type: string;
}

export interface SavedScreenshot {
  outputPath: string;
  sizeBytes: number;
}

export function createChromeBrowserClient(config: AuthConfig) {
  return {
    getExecutablePath: (): string => config.chromePath,
    isHeadlessDefault: (): boolean => config.headless,
    getCdpUrl: (): string => getCdpUrl(config),
    checkExecutable: (): ExecutableStatus => checkExecutable(config.chromePath),
    launch: async (options?: LaunchOptions): Promise<LaunchResult> => launch(config, options),
    open: async (url: string, options?: OpenOptions): Promise<LaunchResult> => open(config, url, options),
    launchDaemon: async (): Promise<LaunchResult> => launchDaemon(config),
    listTabs: async (): Promise<TabInfo[]> => listTabs(config),
    gridScreenshot: async (options?: GridRange): Promise<Buffer> => gridScreenshot(config, options),
    gridScreenshotBase64: async (options?: GridRange): Promise<string> => gridScreenshotBase64(config, options),
    saveGridScreenshot: async (outputPath: string, options?: GridRange): Promise<SavedScreenshot> =>
      saveGridScreenshot(config, outputPath, options),
    scanZones: async (zones: Zone[]): Promise<ZoneResult[]> => scanZones(config, zones),
    execute: async (action: Action): Promise<void> => execute(config, action),
  };
}

async function launch(config: AuthConfig, options: LaunchOptions = {}): Promise<LaunchResult> {
  const daemon = await launchDaemon(config);
  if (!options.url) return daemon;

  await runBridge(config, {
    op: 'navigate',
    url: options.url,
    newWindow: Boolean(options.newWindow),
  });

  return daemon;
}

async function open(config: AuthConfig, url: string, options: OpenOptions = {}): Promise<LaunchResult> {
  return launch(config, { url, newWindow: options.newWindow });
}

async function launchDaemon(config: AuthConfig): Promise<LaunchResult> {
  const cdpUrl = getCdpUrl(config);
  if (await isCdpReachable(cdpUrl)) {
    return {
      pid: null,
      command: config.chromePath,
      args: daemonArgs(config),
      cdpUrl,
      launched: false,
    };
  }

  const launchResult = spawnDaemon(config);
  const ready = await waitForCdp(cdpUrl, CDP_WAIT_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`Unable to connect to Chrome CDP at ${cdpUrl} after launch.`);
  }

  return launchResult;
}

function spawnDaemon(config: AuthConfig): LaunchResult {
  const args = daemonArgs(config);
  const child = spawn(config.chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return {
    pid: child.pid ?? null,
    command: config.chromePath,
    args,
    cdpUrl: getCdpUrl(config),
    launched: true,
  };
}

function daemonArgs(config: AuthConfig): string[] {
  const args: string[] = [
    `--remote-debugging-port=${config.remoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (config.userDataDir) {
    args.push(`--user-data-dir=${config.userDataDir}`);
  }

  if (config.headless) {
    args.push('--headless=new', '--disable-gpu');
  }

  args.push('about:blank');
  return args;
}

function checkExecutable(command: string): ExecutableStatus {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });

  if (result.error) {
    return {
      ok: false,
      command,
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      command,
      error: result.stderr?.trim() || `Exit code ${result.status}`,
    };
  }

  return {
    ok: true,
    command,
    versionOutput: result.stdout.trim(),
  };
}

async function gridScreenshot(config: AuthConfig, options?: GridRange): Promise<Buffer> {
  await launchDaemon(config);
  const result = await runBridge(config, {
    op: 'gridScreenshot',
    start: options?.start,
    end: options?.end,
  });

  if (!result?.imageBase64) {
    throw new Error('Bridge returned no image for gridScreenshot.');
  }

  return Buffer.from(String(result.imageBase64), 'base64');
}

async function gridScreenshotBase64(config: AuthConfig, options?: GridRange): Promise<string> {
  const image = await gridScreenshot(config, options);
  return image.toString('base64');
}

async function saveGridScreenshot(config: AuthConfig, outputPath: string, options?: GridRange): Promise<SavedScreenshot> {
  const image = await gridScreenshot(config, options);
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, image);
  return {
    outputPath: resolvedPath,
    sizeBytes: image.byteLength,
  };
}

async function scanZones(config: AuthConfig, zones: Zone[]): Promise<ZoneResult[]> {
  await launchDaemon(config);
  const result = await runBridge(config, {
    op: 'scanZones',
    zones,
  });

  return (result?.zones ?? []) as ZoneResult[];
}

async function execute(config: AuthConfig, action: Action): Promise<void> {
  await launchDaemon(config);
  await runBridge(config, {
    op: 'execute',
    action,
  });
}

async function listTabs(config: AuthConfig): Promise<TabInfo[]> {
  await launchDaemon(config);
  const response = await fetch(`${getCdpUrl(config).replace(/\/$/, '')}/json`);
  if (!response.ok) {
    throw new Error(`Failed to list tabs from CDP endpoint: HTTP ${response.status}`);
  }

  const targets = (await response.json()) as Array<Record<string, unknown>>;
  return targets
    .filter((target) => target.type === 'page')
    .map((target) => ({
      id: String(target.id || ''),
      type: String(target.type || ''),
      title: String(target.title || ''),
      url: String(target.url || ''),
    }));
}

function getCdpUrl(config: AuthConfig): string {
  if (config.cdpUrl) return config.cdpUrl;
  return `http://127.0.0.1:${config.remoteDebuggingPort}`;
}

async function isCdpReachable(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isCdpReachable(cdpUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function runBridge(config: AuthConfig, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const task = {
    cdpUrl: getCdpUrl(config),
    payload,
  };

  return new Promise((resolve, reject) => {
    const child = spawn('node', [BRIDGE_PATH, JSON.stringify(task)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `CDP bridge failed with exit code ${code}`;
        reject(new Error(message));
        return;
      }

      const out = stdout.trim();
      if (!out) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(out) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`Failed to parse bridge output: ${String(error)}\nOutput: ${out}`));
      }
    });
  });
}
