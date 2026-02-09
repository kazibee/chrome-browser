import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthConfig } from './auth';

const CDP_WAIT_TIMEOUT_MS = 12_000;
const BRIDGE_TIMEOUT_MS = 120_000;
const BRIDGE_PATH = fileURLToPath(new URL('./cdp-bridge.mjs', import.meta.url));
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_LABELS_MODEL = 'gemini-2.5-pro';
const GEMINI_REQUEST_TIMEOUT_MS = 90_000;

export type PageLoadState = 'domcontentloaded' | 'load' | 'networkidle';
export type SelectorWaitState = 'attached' | 'detached' | 'visible' | 'hidden';
export type GridCoordinateSpace = 'viewport' | 'page';

export interface WaitStrategyOptions {
  waitUntil?: PageLoadState;
  timeoutMs?: number;
}

export interface LaunchOptions extends WaitStrategyOptions {
  url?: string;
  newWindow?: boolean;
}

export interface OpenOptions extends WaitStrategyOptions {
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
  selector: string;
  tag: string;
  text: string;
  href?: string;
  placeholder?: string;
  type?: string;
  role?: string;
  label?: string;
}

export interface ZoneResult {
  zone: string;
  elements: ElementInfo[];
}

export interface NavigationWaitOptions {
  waitUntil?: PageLoadState;
  timeoutMs?: number;
  urlIncludes?: string;
  urlMatches?: string;
}

export interface ScanZonesOptions extends WaitStrategyOptions {
  coordinateSpace?: GridCoordinateSpace;
}

export type Action =
  | { type: 'click'; selector: string; waitForNavigation?: boolean | NavigationWaitOptions }
  | { type: 'type'; selector: string; text: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'submit'; selector: string; waitForNavigation?: boolean | NavigationWaitOptions }
  | { type: 'waitForLoadState'; state?: PageLoadState; timeoutMs?: number }
  | { type: 'waitForSelector'; selector: string; state?: SelectorWaitState; timeoutMs?: number }
  | { type: 'waitForUrl'; urlIncludes?: string; urlMatches?: string; timeoutMs?: number }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'navigate'; url: string; waitUntil?: PageLoadState; timeoutMs?: number };

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

export interface LabelsOptions extends WaitStrategyOptions {
  model?: string;
  detailLevel?: 'high' | 'extreme';
  requestTimeoutMs?: number;
}

export interface LabelsOverviewOptions extends WaitStrategyOptions {
  model?: string;
  requestTimeoutMs?: number;
}

export interface ZoneLabelsOptions extends WaitStrategyOptions {
  model?: string;
  detailLevel?: 'high' | 'extreme';
  focus?: string;
  requestTimeoutMs?: number;
}

export interface ZoneLabelsResult {
  zone: string;
  labels: UiLabelsResult;
}

/** Options for locating a single interactive element from a natural-language query. */
export interface FindInteractiveElementOptions extends WaitStrategyOptions {
  model?: string;
  requestTimeoutMs?: number;
}

export interface UiLayoutRegion {
  id: string;
  gridRange: string;
  regionType: string;
  purpose: string;
  keyContents: string[];
}

export interface UiInteractiveElement {
  id: string;
  gridRef: string;
  elementType: string;
  role?: string;
  text: string;
  actionability: string;
  likelyActions: string[];
  importance: string;
  whyItMatters: string;
  confidence: number;
}

export interface UiPointOfInterest {
  id: string;
  gridRef: string;
  title: string;
  category: string;
  detail: string;
  reason: string;
  relatedElementIds: string[];
  confidence: number;
}

export interface UiLabelsResult {
  pageSummary: string;
  pageType: string;
  layoutRegions: UiLayoutRegion[];
  interactiveElements: UiInteractiveElement[];
  pointsOfInterest: UiPointOfInterest[];
  keyFlows: string[];
  risksAndWatchouts: string[];
  confidence: number;
  model: string;
  gridSpace?: GridCoordinateSpace;
}

export interface UiOverviewRegion {
  gridRange: string;
  description: string;
}

export interface UiOverviewResult {
  pageSummary: string;
  pageType: string;
  regions: UiOverviewRegion[];
  confidence: number;
  model: string;
  gridSpace?: GridCoordinateSpace;
}

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
}

type LabelsPromptMode = 'full' | 'zone';

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
    gridScreenshot: async (options?: GridRange, wait?: WaitStrategyOptions): Promise<Buffer> => gridScreenshot(config, options, wait),
    gridScreenshotBase64: async (options?: GridRange, wait?: WaitStrategyOptions): Promise<string> =>
      gridScreenshotBase64(config, options, wait),
    saveGridScreenshot: async (outputPath: string, options?: GridRange, wait?: WaitStrategyOptions): Promise<SavedScreenshot> =>
      saveGridScreenshot(config, outputPath, options, wait),
    /** Captures a full grid screenshot and requests Gemini to label key UI regions and elements. */
    labels: async (options?: LabelsOptions): Promise<UiLabelsResult> => labels(config, options),
    /** Captures a full grid screenshot and requests a minimal overview (ranges + descriptions). */
    labelsOverview: async (options?: LabelsOverviewOptions): Promise<UiOverviewResult> => labelsOverview(config, options),
    /** Captures a grid screenshot cropped to a range and asks Gemini for zone-focused labels. */
    labelsInRange: async (range: GridRange, options?: ZoneLabelsOptions): Promise<UiLabelsResult> =>
      labelsInRange(config, range, options),
    /** Runs zone-focused Gemini labels for each range and returns per-zone results. */
    labelsByZones: async (zones: Zone[], options?: ZoneLabelsOptions): Promise<ZoneLabelsResult[]> =>
      labelsByZones(config, zones, options),
    /** Finds one best-matching interactive element for a query using Gemini + grid screenshot analysis. */
    findInteractiveElement: async (query: string, options?: FindInteractiveElementOptions): Promise<UiInteractiveElement> =>
      findInteractiveElement(config, query, options),
    scanZones: async (zones: Zone[], options?: ScanZonesOptions): Promise<ZoneResult[]> => scanZones(config, zones, options),
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
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
  });

  return daemon;
}

async function open(config: AuthConfig, url: string, options: OpenOptions = {}): Promise<LaunchResult> {
  return launch(config, {
    url,
    newWindow: options.newWindow,
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
  });
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

async function gridScreenshot(config: AuthConfig, options?: GridRange, wait: WaitStrategyOptions = {}): Promise<Buffer> {
  return gridScreenshotInternal(config, options, false, wait);
}

async function gridScreenshotInternal(
  config: AuthConfig,
  options?: GridRange,
  fullPage = false,
  wait: WaitStrategyOptions = {},
): Promise<Buffer> {
  await launchDaemon(config);
  const result = await runBridge(config, {
    op: 'gridScreenshot',
    start: options?.start,
    end: options?.end,
    fullPage,
    waitUntil: wait.waitUntil,
    timeoutMs: wait.timeoutMs,
  });

  if (!result?.imageBase64) {
    throw new Error('Bridge returned no image for gridScreenshot.');
  }

  return Buffer.from(String(result.imageBase64), 'base64');
}

async function gridScreenshotBase64(config: AuthConfig, options?: GridRange, wait: WaitStrategyOptions = {}): Promise<string> {
  const image = await gridScreenshot(config, options, wait);
  return image.toString('base64');
}

async function gridScreenshotBase64Internal(
  config: AuthConfig,
  options?: GridRange,
  fullPage = false,
  wait: WaitStrategyOptions = {},
): Promise<string> {
  const image = await gridScreenshotInternal(config, options, fullPage, wait);
  return image.toString('base64');
}

async function saveGridScreenshot(
  config: AuthConfig,
  outputPath: string,
  options?: GridRange,
  wait: WaitStrategyOptions = {},
): Promise<SavedScreenshot> {
  const image = await gridScreenshot(config, options, wait);
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, image);
  return {
    outputPath: resolvedPath,
    sizeBytes: image.byteLength,
  };
}

async function labels(config: AuthConfig, options: LabelsOptions = {}): Promise<UiLabelsResult> {
  if (!config.geminiApiKey) {
    throw new Error('Missing GEMINI_API_KEY in environment. labels() requires Gemini.');
  }

  const screenshotBase64 = await gridScreenshotBase64(config, undefined, {
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
  });
  const model = normalizeModelName(options.model?.trim() || DEFAULT_LABELS_MODEL);
  const detailLevel = options.detailLevel || 'extreme';
  const analysis = await runLabelsAnalysis(
    config.geminiApiKey,
    model,
    screenshotBase64,
    detailLevel,
    'full',
    undefined,
    undefined,
    options.requestTimeoutMs,
  );
  return {
    ...analysis,
    gridSpace: 'viewport',
  };
}

async function labelsOverview(config: AuthConfig, options: LabelsOverviewOptions = {}): Promise<UiOverviewResult> {
  if (!config.geminiApiKey) {
    throw new Error('Missing GEMINI_API_KEY in environment. labelsOverview() requires Gemini.');
  }

  const screenshotBase64 = await gridScreenshotBase64Internal(
    config,
    undefined,
    true,
    {
      waitUntil: options.waitUntil,
      timeoutMs: options.timeoutMs,
    },
  );
  const model = normalizeModelName(options.model?.trim() || DEFAULT_LABELS_MODEL);
  const analysis = await runOverviewAnalysis(config.geminiApiKey, model, screenshotBase64, options.requestTimeoutMs);
  return {
    ...analysis,
    gridSpace: 'page',
  };
}

async function labelsInRange(config: AuthConfig, range: GridRange, options: ZoneLabelsOptions = {}): Promise<UiLabelsResult> {
  if (!config.geminiApiKey) {
    throw new Error('Missing GEMINI_API_KEY in environment. labelsInRange() requires Gemini.');
  }

  const normalizedRange = normalizeGridRange(range);
  const screenshotBase64 = await gridScreenshotBase64(config, normalizedRange, {
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
  });
  const model = normalizeModelName(options.model?.trim() || DEFAULT_LABELS_MODEL);
  const detailLevel = options.detailLevel || 'extreme';
  const analysis = await runLabelsAnalysis(
    config.geminiApiKey,
    model,
    screenshotBase64,
    detailLevel,
    'zone',
    normalizedRange,
    options.focus,
    options.requestTimeoutMs,
  );
  return {
    ...analysis,
    gridSpace: 'viewport',
  };
}

async function labelsByZones(config: AuthConfig, zones: Zone[], options: ZoneLabelsOptions = {}): Promise<ZoneLabelsResult[]> {
  const results: ZoneLabelsResult[] = [];
  for (const zone of zones) {
    const range = normalizeGridRange(zone);
    const labelsResult = await labelsInRange(config, range, options);
    results.push({
      zone: `${range.start.toUpperCase()}:${range.end.toUpperCase()}`,
      labels: labelsResult,
    });
  }
  return results;
}

async function runLabelsAnalysis(
  apiKey: string,
  model: string,
  screenshotBase64: string,
  detailLevel: 'high' | 'extreme',
  mode: LabelsPromptMode,
  range?: GridRange,
  focus?: string,
  requestTimeoutMs?: number,
): Promise<UiLabelsResult> {
  const body = {
    contents: [
      {
        parts: [
          {
            text: buildLabelsPrompt(detailLevel, mode, range, focus),
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: screenshotBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  try {
    const data = await geminiGenerateContent(apiKey, model, body, requestTimeoutMs);
    const text = extractGeminiText(data);
    const parsed = parseJsonObject(text);
    return normalizeLabelsResult(parsed, model);
  } catch (error) {
    const shouldRetry = /valid JSON object|returned no text content/i.test(String(error));
    if (!shouldRetry) throw error;

    const retryBody = {
      contents: [
        {
          parts: [
            {
              text: buildLabelsPrompt(detailLevel, mode, range, focus, true),
            },
            {
              inlineData: {
                mimeType: 'image/png',
                data: screenshotBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    };

    const retryData = await geminiGenerateContent(apiKey, model, retryBody, requestTimeoutMs);
    const retryText = extractGeminiText(retryData);
    const retryParsed = parseJsonObject(retryText);
    return normalizeLabelsResult(retryParsed, model);
  }
}

async function runOverviewAnalysis(
  apiKey: string,
  model: string,
  screenshotBase64: string,
  requestTimeoutMs?: number,
): Promise<UiOverviewResult> {
  const body = {
    contents: [
      {
        parts: [
          {
            text: buildOverviewPrompt(false),
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: screenshotBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  try {
    const data = await geminiGenerateContent(apiKey, model, body, requestTimeoutMs);
    const text = extractGeminiText(data);
    const parsed = parseJsonObject(text);
    return normalizeOverviewResult(parsed, model);
  } catch (error) {
    const shouldRetry = /valid JSON object|returned no text content/i.test(String(error));
    if (!shouldRetry) throw error;

    const retryBody = {
      contents: [
        {
          parts: [
            {
              text: buildOverviewPrompt(true),
            },
            {
              inlineData: {
                mimeType: 'image/png',
                data: screenshotBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    };

    const retryData = await geminiGenerateContent(apiKey, model, retryBody, requestTimeoutMs);
    const retryText = extractGeminiText(retryData);
    const retryParsed = parseJsonObject(retryText);
    return normalizeOverviewResult(retryParsed, model);
  }
}

async function findInteractiveElement(
  config: AuthConfig,
  query: string,
  options: FindInteractiveElementOptions = {},
): Promise<UiInteractiveElement> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error('findInteractiveElement() requires a non-empty query.');
  }

  const model = normalizeModelName(options.model?.trim() || DEFAULT_LABELS_MODEL);
  const high = await labels(config, {
    model,
    detailLevel: 'high',
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const highMatch = findBestInteractiveElement(high.interactiveElements, normalizedQuery);
  if (highMatch) return highMatch;

  const extreme = await labels(config, {
    model,
    detailLevel: 'extreme',
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const extremeMatch = findBestInteractiveElement(extreme.interactiveElements, normalizedQuery);
  if (extremeMatch) return extremeMatch;

  throw new Error(
    `No interactive element matched query "${normalizedQuery}" from ${high.interactiveElements.length + extreme.interactiveElements.length} Gemini-labeled elements.`,
  );
}

function findBestInteractiveElement(elements: UiInteractiveElement[], query: string): UiInteractiveElement | undefined {
  const phrase = query.toLowerCase();
  const tokens = phrase
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let best: UiInteractiveElement | undefined;
  let bestScore = 0;

  for (const element of elements) {
    const core = [
      element.id,
      element.text,
      element.elementType,
      element.role ?? '',
    ]
      .join(' ')
      .toLowerCase();
    const aux = [
      element.gridRef,
      element.actionability,
      ...element.likelyActions,
    ]
      .join(' ')
      .toLowerCase();

    let score = 0;
    const phraseInCore = core.includes(phrase);
    const phraseInAux = aux.includes(phrase);
    if (phraseInCore) score += 80;
    if (phraseInAux) score += 20;
    if (element.text.toLowerCase() === phrase) score += 20;
    if (element.id.toLowerCase() === phrase) score += 20;

    let tokenMatchesCore = 0;
    let tokenMatchesAux = 0;
    for (const token of tokens) {
      if (core.includes(token)) tokenMatchesCore += 1;
      else if (aux.includes(token)) tokenMatchesAux += 1;

      if (element.text.toLowerCase().includes(token)) score += 4;
      if (element.id.toLowerCase().includes(token)) score += 4;
    }

    score += tokenMatchesCore * 16;
    score += tokenMatchesAux * 4;

    const coverage = tokens.length ? (tokenMatchesCore + tokenMatchesAux) / tokens.length : 1;
    if (!phraseInCore && !phraseInAux && coverage < 0.5) {
      continue;
    }

    if (element.importance.toLowerCase() === 'critical') score += 2;
    if (element.importance.toLowerCase() === 'high') score += 1;

    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : undefined;
}

async function scanZones(config: AuthConfig, zones: Zone[], options: ScanZonesOptions = {}): Promise<ZoneResult[]> {
  await launchDaemon(config);
  const result = await runBridge(config, {
    op: 'scanZones',
    zones,
    waitUntil: options.waitUntil,
    timeoutMs: options.timeoutMs,
    coordinateSpace: options.coordinateSpace,
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

async function geminiGenerateContent(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  requestTimeoutMs?: number,
): Promise<GeminiResponse> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const timeoutMs = normalizeTimeoutMs(requestTimeoutMs, GEMINI_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as GeminiResponse & Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractGeminiText(data: GeminiResponse): string {
  const texts = (data.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim() || '')
    .filter(Boolean);

  if (!texts.length) {
    throw new Error(`Gemini returned no text content: ${JSON.stringify(data)}`);
  }

  return texts.join('\n');
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const codeFenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (codeFenceMatch?.[1]) {
    candidates.unshift(codeFenceMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next parse candidate.
    }
  }

  throw new Error(`Gemini response was not valid JSON object. Raw response: ${trimmed}`);
}

function normalizeLabelsResult(value: Record<string, unknown>, model: string): UiLabelsResult {
  const layoutRegions = toArray(value.layoutRegions).map((item, index) => {
    const region = toRecord(item);
    return {
      id: toNonEmptyString(region.id, `region_${index + 1}`),
      gridRange: toNonEmptyString(region.gridRange, ''),
      regionType: toNonEmptyString(region.regionType, 'unknown'),
      purpose: toNonEmptyString(region.purpose, ''),
      keyContents: toStringArray(region.keyContents),
    };
  });

  const interactiveElements = toArray(value.interactiveElements).map((item, index) => {
    const element = toRecord(item);
    return normalizeInteractiveElement(element, `element_${index + 1}`);
  });

  const pointsOfInterest = toArray(value.pointsOfInterest).map((item, index) => {
    const poi = toRecord(item);
    return {
      id: toNonEmptyString(poi.id, `poi_${index + 1}`),
      gridRef: toNonEmptyString(poi.gridRef, ''),
      title: toNonEmptyString(poi.title, ''),
      category: toNonEmptyString(poi.category, 'unknown'),
      detail: toNonEmptyString(poi.detail, ''),
      reason: toNonEmptyString(poi.reason, ''),
      relatedElementIds: toStringArray(poi.relatedElementIds),
      confidence: toConfidence(poi.confidence),
    };
  });

  return {
    pageSummary: toNonEmptyString(value.pageSummary, ''),
    pageType: toNonEmptyString(value.pageType, 'unknown'),
    layoutRegions,
    interactiveElements,
    pointsOfInterest,
    keyFlows: toStringArray(value.keyFlows),
    risksAndWatchouts: toStringArray(value.risksAndWatchouts),
    confidence: toConfidence(value.confidence),
    model,
  };
}

function normalizeOverviewResult(value: Record<string, unknown>, model: string): UiOverviewResult {
  const directRegions = toArray(value.regions).map((item) => {
    const region = toRecord(item);
    return {
      gridRange: toNonEmptyString(region.gridRange, ''),
      description: toNonEmptyString(region.description, ''),
    };
  });

  const fallbackRegions = toArray(value.layoutRegions).map((item) => {
    const region = toRecord(item);
    const purpose = toNonEmptyString(region.purpose, '');
    const keyContents = toStringArray(region.keyContents).join(', ');
    const description = [purpose, keyContents].filter(Boolean).join(' | ');
    return {
      gridRange: toNonEmptyString(region.gridRange, ''),
      description: description || 'Region',
    };
  });

  const regions = directRegions.length ? directRegions : fallbackRegions;

  return {
    pageSummary: toNonEmptyString(value.pageSummary, ''),
    pageType: toNonEmptyString(value.pageType, 'unknown'),
    regions: regions
      .filter((region) => region.gridRange && region.description)
      .slice(0, 8),
    confidence: toConfidence(value.confidence),
    model,
  };
}

function normalizeInteractiveElement(value: Record<string, unknown>, fallbackId: string): UiInteractiveElement {
  return {
    id: toNonEmptyString(value.id, fallbackId),
    gridRef: toNonEmptyString(value.gridRef, ''),
    elementType: toNonEmptyString(value.elementType, 'unknown'),
    role: toOptionalString(value.role),
    text: toNonEmptyString(value.text, ''),
    actionability: toNonEmptyString(value.actionability, ''),
    likelyActions: toStringArray(value.likelyActions),
    importance: toNonEmptyString(value.importance, 'unknown'),
    whyItMatters: toNonEmptyString(value.whyItMatters, ''),
    confidence: toConfidence(value.confidence),
  };
}

function buildLabelsPrompt(
  detailLevel: 'high' | 'extreme',
  mode: LabelsPromptMode,
  range?: GridRange,
  focus?: string,
  compactRetry = false,
): string {
  const keyAreasOnly = detailLevel === 'high';
  const depthInstruction = keyAreasOnly
    ? 'Focus only on key interactive areas and high-value controls for common user actions.'
    : 'Be exhaustive and highly specific. Include all visible interactive elements and nuanced context.';
  const modeInstruction =
    mode === 'zone'
      ? `This screenshot is a cropped zone for deeper analysis${range ? ` (${range.start.toUpperCase()}:${range.end.toUpperCase()})` : ''}. Keep all grid references exactly as shown in the image.`
      : 'This is a full-page analysis pass.';
  const focusInstruction = focus?.trim() ? `Primary focus: ${focus.trim()}` : '';

  const lines = [
    'You are a senior web UI analyst.',
    'Analyze the provided browser screenshot, which already includes an overlaid grid labeling each cell.',
    'Use those grid labels (for example A1, C4, B2:D4) in your output for locations.',
    modeInstruction,
    depthInstruction,
    focusInstruction,
    'Return ONLY JSON (no markdown) with this exact shape:',
    '{',
    '  "pageSummary": "string",',
    '  "pageType": "string",',
    '  "layoutRegions": [',
    '    {',
    '      "id": "string",',
    '      "gridRange": "string",',
    '      "regionType": "string",',
    '      "purpose": "string",',
    '      "keyContents": ["string"]',
    '    }',
    '  ],',
    '  "interactiveElements": [',
    '    {',
    '      "id": "string",',
    '      "gridRef": "string",',
    '      "elementType": "string",',
    '      "role": "string",',
    '      "text": "string",',
    '      "actionability": "string",',
    '      "likelyActions": ["string"],',
    '      "importance": "critical|high|medium|low",',
    '      "whyItMatters": "string",',
    '      "confidence": 0.0',
    '    }',
    '  ],',
    '  "pointsOfInterest": [',
    '    {',
    '      "id": "string",',
    '      "gridRef": "string",',
    '      "title": "string",',
    '      "category": "string",',
    '      "detail": "string",',
    '      "reason": "string",',
    '      "relatedElementIds": ["string"],',
    '      "confidence": 0.0',
    '    }',
    '  ],',
    '  "keyFlows": ["string"],',
    '  "risksAndWatchouts": ["string"],',
    '  "confidence": 0.0',
    '}',
    'Requirements:',
    '- Prefer precise grid references and use ranges when an element spans multiple cells.',
    '- Key flows must describe concrete user journeys that are possible from this exact page.',
    '- Confidence values must be numbers from 0 to 1.',
    '- Do not output anything except one valid JSON object.',
  ];

  if (keyAreasOnly) {
    lines.push('- Include only key interactive areas. Skip low-value/legal/footer links unless critical.');
    lines.push('- Keep output concise.');
    lines.push('- Return at most 4 layoutRegions, 8 interactiveElements, and 5 pointsOfInterest.');
    lines.push('- Prioritize critical and high-importance controls.');
  } else {
    lines.push(
      '- Capture all visible interactive controls, including subtle controls (icon buttons, tabs, dropdown triggers, toggles, search fields, contextual menus).',
    );
  }

  if (compactRetry) {
    lines.push('- Keep every string short and concrete (roughly <= 12 words per text field).');
    lines.push('- Keep arrays minimal while preserving key signal.');
  }

  return lines.join('\n');
}

function buildOverviewPrompt(compactRetry: boolean): string {
  const lines = [
    'You are a senior web UI analyst.',
    'Analyze the browser screenshot with grid labels.',
    'Return ONLY JSON (no markdown) with this exact shape:',
    '{',
    '  "pageSummary": "string",',
    '  "pageType": "string",',
    '  "regions": [',
    '    {',
    '      "gridRange": "string",',
    '      "description": "string"',
    '    }',
    '  ],',
    '  "confidence": 0.0',
    '}',
    'Requirements:',
    '- Include only the most important visible regions.',
    '- Keep descriptions short and concrete.',
    '- Return at most 6 regions.',
    '- Confidence must be 0..1.',
    '- Do not output anything except one valid JSON object.',
  ];

  if (compactRetry) {
    lines.push('- Keep each description to 5-10 words.');
  }

  return lines.join('\n');
}

function normalizeGridRange(range: GridRange): GridRange {
  const start = String(range.start || '').trim();
  const end = String(range.end || '').trim();
  if (!start || !end) {
    throw new Error('Grid range requires both "start" and "end" coordinates.');
  }
  return { start, end };
}

function normalizeModelName(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function normalizeTimeoutMs(value: unknown, fallbackMs: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string };
  return candidate.name === 'AbortError';
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNonEmptyString(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function toOptionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
}

function toConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
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

    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const op = typeof payload.op === 'string' ? payload.op : 'unknown';
      reject(new Error(`CDP bridge timed out after ${BRIDGE_TIMEOUT_MS}ms (op: ${op}).`));
    }, BRIDGE_TIMEOUT_MS);

    const settle = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settle(() => reject(error));
    });

    child.on('close', (code) => {
      settle(() => {
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
  });
}
