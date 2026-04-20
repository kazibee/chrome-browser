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

export async function view() {
  const env = process.env as Env;
  const port = env.CHROME_REMOTE_DEBUGGING_PORT?.trim() || '9222';
  const cdpUrl = env.CHROME_CDP_URL?.trim() || `http://127.0.0.1:${port}`;
  const base = cdpUrl.replace(/\/$/, '');

  // Check reachability without launching a daemon
  let connected = false;
  try {
    const res = await fetch(`${base}/json/version`);
    connected = res.ok;
  } catch {
    connected = false;
  }

  if (!connected) {
    console.log('Browser: not connected');
    return;
  }

  // Fetch open tabs
  const res = await fetch(`${base}/json`);
  const targets = (await res.json()) as Array<Record<string, unknown>>;
  const pages = targets.filter((t) => t.type === 'page');

  console.log('Browser: connected');
  console.log(`Tabs: ${pages.length}`);

  if (pages.length > 0) {
    const active = pages[0];
    console.log(`URL: ${active.url}`);
    console.log(`Title: ${active.title}`);
  }
}

export async function labels(first?: string | string[], ...rest: string[]) {
  const args = normalizeArgs(first, rest);
  const [model] = args;
  const client = main(process.env as Env);
  const result = await client.labels(model ? { model } : undefined);

  return {
    ok: true,
    result,
  } as CommandResult<typeof result>;
}

export async function find(first?: string | string[], ...rest: string[]) {
  const args = normalizeArgs(first, rest);
  if (!args.length) {
    throw new Error('Usage: kazibee chrome-browser find <query> [--model <model>]');
  }

  let model: string | undefined;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--model') {
      model = args[i + 1];
      i += 1;
      continue;
    }
    queryParts.push(token);
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    throw new Error('Usage: kazibee chrome-browser find <query> [--model <model>]');
  }

  const client = main(process.env as Env);
  const result = await client.findInteractiveElement(query, model ? { model } : undefined);

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
      'kazibee chrome-browser view',
      'kazibee chrome-browser labels [model]',
      'kazibee chrome-browser find <query> [--model <model>]',
      'All browser operations are CDP-backed; no non-CDP mode is supported.',
    ],
  };
}

function normalizeArgs(first?: string | string[], rest: string[] = []): string[] {
  if (Array.isArray(first)) return [...first, ...rest].filter(Boolean);
  if (typeof first === 'string') return [first, ...rest].filter(Boolean);
  return [...rest].filter(Boolean);
}
