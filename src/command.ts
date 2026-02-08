import main from './index';
import type { Env } from './auth';

export interface LoginResult {
  ok: true;
}

export interface CommandHelp {
  ok: true;
  usage: string[];
}

export interface CommandResult<T> {
  ok: true;
  result: T;
}

export async function login(): Promise<LoginResult> {
  return { ok: true };
}

export async function open(first?: string | string[], ...rest: string[]) {
  const args = normalizeArgs(first, rest);
  const [url, ...flags] = args;

  if (!url) {
    throw new Error('Usage: kazibee chrome-browser open <url> [--new-window]');
  }

  const client = main(process.env as Env);
  const result = await client.open(url, { newWindow: flags.includes('--new-window') });

  return {
    ok: true,
    result,
  } as CommandResult<typeof result>;
}

export async function launch() {
  const client = main(process.env as Env);
  const result = await client.launchDaemon();

  return {
    ok: true,
    result,
  } as CommandResult<typeof result>;
}

export async function daemon() {
  return launch();
}

export async function tabs() {
  const client = main(process.env as Env);
  const result = await client.listTabs();

  return {
    ok: true,
    result,
  } as CommandResult<typeof result>;
}

export async function screenshot(first?: string | string[], ...rest: string[]) {
  const args = normalizeArgs(first, rest);
  const [outputPath, start, end] = args;
  if (!outputPath) {
    throw new Error('Usage: kazibee chrome-browser screenshot <outputPath> [startCell endCell]');
  }

  const client = main(process.env as Env);
  const result =
    start && end ? await client.saveGridScreenshot(outputPath, { start, end }) : await client.saveGridScreenshot(outputPath);

  return {
    ok: true,
    result,
  } as CommandResult<typeof result>;
}

export async function help(): Promise<CommandHelp> {
  return {
    ok: true,
    usage: [
      'kazibee chrome-browser launch',
      'kazibee chrome-browser daemon',
      'kazibee chrome-browser open <url> [--new-window]',
      'kazibee chrome-browser tabs',
      'kazibee chrome-browser screenshot <outputPath> [startCell endCell]',
      'All browser operations are CDP-backed; no non-CDP mode is supported.',
    ],
  };
}

function normalizeArgs(first?: string | string[], rest: string[] = []): string[] {
  if (Array.isArray(first)) return [...first, ...rest].filter(Boolean);
  if (typeof first === 'string') return [first, ...rest].filter(Boolean);
  return [...rest].filter(Boolean);
}
