import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Env {
  GEMINI_API_KEY?: string;
  CHROME_PATH?: string;
  CHROME_USER_DATA_DIR?: string;
  CHROME_HEADLESS?: string;
  CHROME_REMOTE_DEBUGGING_PORT?: string;
  CHROME_CDP_URL?: string;
  CHROME_AUTO_LAUNCH?: string;
}

export interface AuthConfig {
  chromePath: string;
  userDataDir?: string;
  headless: boolean;
  remoteDebuggingPort: number;
  cdpUrl?: string;
  autoLaunch: boolean;
}

export function getAuthConfig(env: Env): AuthConfig {
  return {
    chromePath: resolveChromePath(env.CHROME_PATH),
    userDataDir: resolveUserDataDir(env.CHROME_USER_DATA_DIR),
    headless: parseBool(env.CHROME_HEADLESS),
    remoteDebuggingPort: parsePort(env.CHROME_REMOTE_DEBUGGING_PORT, 9222),
    cdpUrl: env.CHROME_CDP_URL?.trim() || undefined,
    autoLaunch: env.CHROME_AUTO_LAUNCH ? parseBool(env.CHROME_AUTO_LAUNCH) : true,
  };
}

function resolveChromePath(explicitPath?: string): string {
  const configuredPath = explicitPath?.trim();
  if (configuredPath) return configuredPath;

  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(macPath)) return macPath;
  }

  if (process.platform === 'win32') {
    return 'chrome.exe';
  }

  return 'google-chrome';
}

function parseBool(value?: string): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePort(value: string | undefined, defaultPort: number): number {
  if (!value) return defaultPort;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return defaultPort;
  }
  return parsed;
}

function resolveUserDataDir(explicitDir?: string): string {
  const configured = explicitDir?.trim();
  if (configured) return configured;
  return join(homedir(), '.profiles', 'kazibee');
}
