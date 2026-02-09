# @kazibee/chrome-browser

CDP-first Chrome navigation and automation tool for KaziBee.

All operations run through a persistent Chrome DevTools Protocol (CDP) instance.
Non-CDP launch/open paths are not supported.

## Install

```bash
kazibee install chrome-browser github:kazibee/chrome-browser
```

## Configuration

Optional environment variables:
- `GEMINI_API_KEY`
- `CHROME_PATH` (Chrome executable path)
- `CHROME_USER_DATA_DIR` (persistent profile dir; default `~/.profiles/kazibee`)
- `CHROME_HEADLESS` (`true`/`false`, default `false`)
- `CHROME_REMOTE_DEBUGGING_PORT` (default `9222`)
- `CHROME_CDP_URL` (override endpoint, e.g. `http://127.0.0.1:9222`)
- `CHROME_AUTO_LAUNCH` (`true`/`false`, default `true`)

## API

- `launchDaemon()` -> ensure CDP Chrome is running
- `launch(options?)` -> ensure daemon and optionally navigate URL
- `open(url, options?)` -> CDP navigation in existing tab by default
- `listTabs()`
- `gridScreenshot(options?, wait?)`
- `gridScreenshotBase64(options?, wait?)`
- `saveGridScreenshot(outputPath, options?, wait?)`
- `labels(options?)` -> full-screen grid screenshot + Gemini UI analysis (throws if `GEMINI_API_KEY` missing)
- `labelsOverview(options?)` -> fast full-page overview returning only `{ gridRange, description }` regions
- `labelsInRange(range, options?)` -> deep Gemini labels for one grid range (smaller image payload)
- `labelsByZones(zones, options?)` -> deep Gemini labels for multiple zones (per-zone results)
- `findInteractiveElement(query, options?)` -> asks Gemini for one best-match interactive element by query
- `scanZones(zones, wait?)`
- `execute(action)`

`wait`/wait options support:
- `waitUntil: "domcontentloaded" | "load" | "networkidle"`
- `timeoutMs: number`
- `requestTimeoutMs: number` (Gemini calls only: `labels`, `labelsOverview`, `labelsInRange`, `labelsByZones`, `findInteractiveElement`)
- `coordinateSpace: "viewport" | "page"` (`scanZones` only; default `"viewport"`)

Grid coordinate spaces:
- `labelsOverview()` uses full-page screenshot grid (`gridSpace: "page"` in result).
- `labels()` and `labelsInRange()` use viewport screenshot grid (`gridSpace: "viewport"` in result).
- Pass matching `coordinateSpace` to `scanZones` so inspected zones align with the analyzed screenshot.
- `scanZones` now normalizes visual grid coordinates to DOM coordinates internally (DPR/scale aware), so zone scans match what the grid image shows.

`scanZones` returns interactive elements with a deterministic `selector` field.
Pass that selector to `execute({ type: "click" | "type" | "select" | "submit", selector, ... })`.
`execute` also supports wait actions:
- `execute({ type: "waitForLoadState", state: "domcontentloaded" | "networkidle", timeoutMs? })`
- `execute({ type: "waitForSelector", selector, state?: "visible" | "attached" | "hidden" | "detached", timeoutMs? })`
- `execute({ type: "waitForUrl", urlIncludes? | urlMatches?, timeoutMs? })`
For actions that should navigate, use `waitForNavigation` on `click`/`submit`:
`execute({ type: "submit", selector, waitForNavigation: { waitUntil: "networkidle", timeoutMs: 12000, urlIncludes: "/search" } })`.
`execute({ type: "navigate", url, waitUntil: "load", timeoutMs: 30000 })` also supports per-call wait strategy.

Recommended interaction flow for unknown pages:
1. Start with `execute({ type: "waitForLoadState", state: "domcontentloaded" })`.
2. Use `labelsOverview()` for quick global mapping of key controls.
3. Use `labelsInRange({ start, end }, { detailLevel: "extreme" })` for focused deep analysis of only the relevant area.
4. Call `scanZones` on that area with matching `coordinateSpace` (expand range if needed) and pick the element by tag/text/role.
5. Execute action with `selector`.
6. Re-run `labelsOverview` (or targeted `labelsInRange`) after state-changing actions before the next step.
7. For forms, prefer `execute({ type: "submit", selector })` on an input/button/form instead of URL shortcuts.

## CLI Commands

- `kazibee chrome-browser launch`
- `kazibee chrome-browser daemon`
- `kazibee chrome-browser open <url> [--new-window]`
- `kazibee chrome-browser tabs`
- `kazibee chrome-browser screenshot <outputPath> [startCell endCell]`
- `kazibee chrome-browser labels [model]`
- `kazibee chrome-browser find <query> [--model <model>]`

## Example

```javascript
const chrome = tools["chrome-browser"];

await chrome.launchDaemon();
await chrome.open("https://www.reddit.com", { waitUntil: "domcontentloaded", timeoutMs: 30000 });

const overview = await chrome.labelsOverview({ model: "gemini-2.5-flash" });
const zones = await chrome.scanZones(
  [{ start: "A1", end: "AL8" }],
  { waitUntil: "domcontentloaded", timeoutMs: 12000, coordinateSpace: overview.gridSpace }
);
const first = zones[0]?.elements[0];
if (first) {
  await chrome.execute({ type: "click", selector: first.selector });
}
```
