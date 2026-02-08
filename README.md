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
- `gridScreenshot(options?)`
- `gridScreenshotBase64(options?)`
- `saveGridScreenshot(outputPath, options?)`
- `scanZones(zones)`
- `execute(action)`

## CLI Commands

- `kazibee chrome-browser launch`
- `kazibee chrome-browser daemon`
- `kazibee chrome-browser open <url> [--new-window]`
- `kazibee chrome-browser tabs`
- `kazibee chrome-browser screenshot <outputPath> [startCell endCell]`

## Example

```javascript
const chrome = tools["chrome-browser"];

await chrome.launchDaemon();
await chrome.open("https://www.reddit.com");

const zones = await chrome.scanZones([{ start: "A1", end: "AL8" }]);
const first = zones[0]?.elements[0];
if (first) {
  await chrome.execute({ type: "click", kb: first.kb });
}
```
