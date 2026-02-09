import { chromium } from 'playwright';
import sharp from 'sharp';

const CELL_SIZE = 100;
const LABEL_MARGIN = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error('Missing bridge task payload.');

  const task = JSON.parse(raw);
  const cdpUrl = String(task.cdpUrl || '').trim();
  const payload = task.payload || {};
  if (!cdpUrl) throw new Error('Missing cdpUrl in bridge payload.');

  const version = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`);
  const wsEndpoint = version.webSocketDebuggerUrl || cdpUrl;

  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 12000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context available over CDP.');

    const op = payload.op;
    let result = {};

    if (op === 'navigate') {
      const page = await getOrCreatePage(context, Boolean(payload.newWindow));
      await page.goto(String(payload.url || ''), {
        waitUntil: normalizeLoadState(payload.waitUntil),
        timeout: normalizeTimeoutMsOrUndefined(payload.timeoutMs),
      });
      result = { ok: true };
    } else if (op === 'execute') {
      const page = await getOrCreatePage(context, false);
      await runExecute(page, payload.action || {});
      result = { ok: true };
    } else if (op === 'scanZones') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const zones = await runScanZones(page, payload.zones || [], normalizeCoordinateSpace(payload.coordinateSpace));
      result = { zones };
    } else if (op === 'gridScreenshot') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runGridScreenshot(page, payload.start, payload.end, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else {
      throw new Error(`Unsupported bridge op: ${String(op)}`);
    }

    process.stdout.write(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

async function getOrCreatePage(context, forceNew) {
  if (forceNew) {
    return context.newPage();
  }
  const pages = context.pages();
  return pages.find((page) => page.url() !== 'about:blank' && page.url() !== 'chrome://newtab/') || pages[0] || context.newPage();
}

async function runExecute(page, action) {
  if (!action || typeof action !== 'object') throw new Error('Missing execute action.');

  if (action.type === 'click') {
    await runWithOptionalNavigation(page, action.waitForNavigation, async () => {
      await page.click(requireSelector(action.selector));
    });
    return;
  }

  if (action.type === 'type') {
    const selector = requireSelector(action.selector);
    await page.fill(selector, '');
    await page.type(selector, String(action.text || ''));
    return;
  }

  if (action.type === 'select') {
    await page.selectOption(requireSelector(action.selector), String(action.value || ''));
    return;
  }

  if (action.type === 'submit') {
    const selector = requireSelector(action.selector);
    await runWithOptionalNavigation(page, action.waitForNavigation, async () => {
      await page.$eval(selector, (node) => {
        const el = node;
        if (el instanceof HTMLFormElement) {
          if (typeof el.requestSubmit === 'function') {
            el.requestSubmit();
          } else {
            el.submit();
          }
          return;
        }

        const parentForm = (el instanceof HTMLElement ? el.closest('form') : null) || (el instanceof HTMLInputElement ? el.form : null);
        if (parentForm) {
          const submitter =
            el instanceof HTMLButtonElement ||
            (el instanceof HTMLInputElement && ['submit', 'image'].includes(String(el.type || '').toLowerCase()))
              ? el
              : undefined;
          if (typeof parentForm.requestSubmit === 'function') {
            parentForm.requestSubmit(submitter);
          } else {
            parentForm.submit();
          }
          return;
        }

        if (el instanceof HTMLElement) {
          el.click();
          return;
        }

        throw new Error('submit action target is not submittable');
      });
    });
    return;
  }

  if (action.type === 'waitForLoadState') {
    await page.waitForLoadState(normalizeLoadState(action.state), {
      timeout: normalizeTimeoutMs(action.timeoutMs),
    });
    return;
  }

  if (action.type === 'waitForSelector') {
    await page.waitForSelector(requireSelector(action.selector), {
      state: normalizeSelectorWaitState(action.state),
      timeout: normalizeTimeoutMs(action.timeoutMs),
    });
    return;
  }

  if (action.type === 'waitForUrl') {
    const timeout = normalizeTimeoutMs(action.timeoutMs);
    const includes = normalizeOptionalString(action.urlIncludes);
    const matches = normalizeOptionalString(action.urlMatches);
    if (!includes && !matches) {
      throw new Error('waitForUrl requires urlIncludes or urlMatches.');
    }
    if (includes) {
      await page.waitForURL((url) => String(url).includes(includes), { timeout, waitUntil: 'domcontentloaded' });
      return;
    }
    await page.waitForURL(new RegExp(matches), { timeout, waitUntil: 'domcontentloaded' });
    return;
  }

  if (action.type === 'scroll') {
    const amount = Number(action.amount || 500);
    const delta = action.direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, delta);
    return;
  }

  if (action.type === 'navigate') {
    await page.goto(String(action.url || ''), {
      waitUntil: normalizeLoadState(action.waitUntil),
      timeout: normalizeTimeoutMsOrUndefined(action.timeoutMs),
    });
    return;
  }

  throw new Error(`Unknown action type: ${String(action.type)}`);
}

async function runScanZones(page, zones, coordinateSpace) {
  const results = [];
  for (const zone of zones) {
    results.push(await runSingleZoneScanWithRetry(page, zone, coordinateSpace));
  }
  return results;
}

async function runSingleZoneScanWithRetry(page, zone, coordinateSpace) {
  const start = parseCell(zone.start);
  const end = parseCell(zone.end);
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const zoneName = `${String(zone.start || '').toUpperCase()}:${String(zone.end || '').toUpperCase()}`;

  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await waitForStableDom(page);
      const elements = await page.evaluate(
        ({ minCol, maxCol, minRow, maxRow, cellSize, coordinateSpace }) => {
          const isInteractive = (el) => {
            const tag = el.tagName;
            if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return true;
            if (tag === 'A' && el.href) return true;
            const role = el.getAttribute('role');
            if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'combobox'].includes(role)) return true;
            if (el.hasAttribute('contenteditable')) return true;
            const tabIndex = el.getAttribute('tabindex');
            if (tabIndex !== null && Number(tabIndex) >= 0) return true;
            if (el.hasAttribute('onclick')) return true;
            return false;
          };

          const getText = (el) => {
            const raw = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return raw.slice(0, 60);
          };

          const intersects = (a, b) => {
            return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          };

          const results = [];
          const seenSelectors = new Set();

          const dpr = Math.max(0.01, Number(window.devicePixelRatio) || 1);
          const cssSpaceWidth = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollWidth) || 1)
            : Math.max(1, Number(window.innerWidth) || 1);
          const cssSpaceHeight = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollHeight) || 1)
            : Math.max(1, Number(window.innerHeight) || 1);

          // The visual grid is drawn on screenshot image pixels. Convert those zone bounds
          // back into CSS-pixel coordinates before intersecting DOM rects.
          const imageSpaceWidth = Math.max(1, cssSpaceWidth * dpr);
          const imageSpaceHeight = Math.max(1, cssSpaceHeight * dpr);
          const scaleX = imageSpaceWidth / cssSpaceWidth;
          const scaleY = imageSpaceHeight / cssSpaceHeight;

          const zoneRectImage = {
            left: minCol * cellSize,
            right: (maxCol + 1) * cellSize,
            top: minRow * cellSize,
            bottom: (maxRow + 1) * cellSize,
          };
          const zoneRect = {
            left: zoneRectImage.left / scaleX,
            right: zoneRectImage.right / scaleX,
            top: zoneRectImage.top / scaleY,
            bottom: zoneRectImage.bottom / scaleY,
          };

          const candidates = new Set();
          const interactiveQuery =
            'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable],[onclick]';
          document.querySelectorAll(interactiveQuery).forEach((el) => candidates.add(el));

          const pointerCandidates = document.querySelectorAll('[style*="cursor: pointer"],[style*="cursor:pointer"]');
          pointerCandidates.forEach((el) => candidates.add(el));

          candidates.forEach((el) => {
            if (!(el instanceof HTMLElement)) return;
            if (!isInteractive(el)) return;

            const rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return;

            const rectInSpace =
              coordinateSpace === 'page'
                ? {
                    left: rect.left + window.scrollX,
                    right: rect.right + window.scrollX,
                    top: rect.top + window.scrollY,
                    bottom: rect.bottom + window.scrollY,
                  }
                : {
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                  };

            if (!intersects(zoneRect, rectInSpace)) return;

            const selector = buildSelector(el);
            if (!selector || seenSelectors.has(selector)) return;
            seenSelectors.add(selector);

            results.push({
              selector,
              tag: el.tagName,
              text: getText(el),
              href: el.tagName === 'A' ? el.href || undefined : undefined,
              placeholder: el.placeholder || undefined,
              type: el.type || undefined,
              role: el.getAttribute('role') || undefined,
              label: el.getAttribute('aria-label') || undefined,
            });
          });

          results.sort((a, b) => {
            const aText = (a.text || '').toLowerCase();
            const bText = (b.text || '').toLowerCase();
            if (aText && bText) return aText.localeCompare(bText);
            if (aText) return -1;
            if (bText) return 1;
            return a.selector.localeCompare(b.selector);
          });

          return results;

          function buildSelector(el) {
            const anchor = findAnchor(el);
            const segments = [];
            let node = el;
            while (node && node !== anchor) {
              segments.unshift(segmentForNode(node));
              node = node.parentElement;
            }

            if (!anchor) {
              return segments.join(' > ');
            }

            const anchorSegment = segmentForAnchor(anchor);
            return [anchorSegment, ...segments].join(' > ');
          }

          function findAnchor(el) {
            let node = el;
            while (node && node.tagName) {
              if (node.id) return node;
              if (node.tagName.toLowerCase() === 'html') return node;
              node = node.parentElement;
            }
            return null;
          }

          function segmentForAnchor(el) {
            const tag = el.tagName.toLowerCase();
            if (el.id) return `${tag}#${escapeCss(el.id)}`;
            return tag;
          }

          function segmentForNode(el) {
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement;
            if (!parent) return tag;

            const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
            if (sameTagSiblings.length <= 1) return tag;
            const position = sameTagSiblings.indexOf(el) + 1;
            return `${tag}:nth-of-type(${position})`;
          }

          function escapeCss(value) {
            if (window.CSS && typeof window.CSS.escape === 'function') {
              return window.CSS.escape(String(value));
            }
            return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
          }
        },
        {
          minCol,
          maxCol,
          minRow,
          maxRow,
          cellSize: CELL_SIZE,
          coordinateSpace,
        },
      );

      return {
        zone: zoneName,
        elements,
      };
    } catch (error) {
      if (!isRecoverableScanError(error) || attempt >= maxAttempts) {
        throw error;
      }
      lastError = error;
      await waitForStableDom(page);
      await sleep(200 * attempt);
    }
  }

  throw lastError || new Error(`Failed to scan zone ${zoneName}.`);
}

function isRecoverableScanError(error) {
  const message = String(error && error.message ? error.message : error);
  return (
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('Frame was detached') ||
    message.includes('Target page, context or browser has been closed')
  );
}

async function waitForStableDom(page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 });
  } catch {
    // Ignore and proceed; some pages stream updates continuously.
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGridScreenshot(page, start, end, fullPage = false) {
  const screenshotBuffer = await page.screenshot({ type: 'png', fullPage, scale: 'device' });
  const metadata = await sharp(screenshotBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (!width || !height) {
    throw new Error('Failed to determine screenshot dimensions.');
  }

  const cols = Math.ceil(width / CELL_SIZE);
  const rows = Math.ceil(height / CELL_SIZE);
  const totalW = width + LABEL_MARGIN;
  const totalH = height + LABEL_MARGIN;

  const svg = buildGridOverlaySvg({
    contentWidth: width,
    contentHeight: height,
    cols,
    rows,
    colOffset: 0,
    rowOffset: 0,
  });

  if (start && end) {
    const from = parseCell(start);
    const to = parseCell(end);
    const minCol = Math.min(from.col, to.col);
    const maxCol = Math.max(from.col, to.col);
    const minRow = Math.min(from.row, to.row);
    const maxRow = Math.max(from.row, to.row);

    const contentLeft = Math.max(0, minCol * CELL_SIZE);
    const contentTop = Math.max(0, minRow * CELL_SIZE);
    const contentRight = Math.min(width, (maxCol + 1) * CELL_SIZE);
    const contentBottom = Math.min(height, (maxRow + 1) * CELL_SIZE);
    const cropWidth = Math.max(1, contentRight - contentLeft);
    const cropHeight = Math.max(1, contentBottom - contentTop);

    const croppedContent = await sharp(screenshotBuffer)
      .extract({
        left: contentLeft,
        top: contentTop,
        width: cropWidth,
        height: cropHeight,
      })
      .png()
      .toBuffer();

    const cropTotalW = cropWidth + LABEL_MARGIN;
    const cropTotalH = cropHeight + LABEL_MARGIN;
    const cropCols = Math.ceil(cropWidth / CELL_SIZE);
    const cropRows = Math.ceil(cropHeight / CELL_SIZE);

    const cropSvg = buildGridOverlaySvg({
      contentWidth: cropWidth,
      contentHeight: cropHeight,
      cols: cropCols,
      rows: cropRows,
      colOffset: minCol,
      rowOffset: minRow,
    });

    const cropOverlay = await sharp(Buffer.from(cropSvg)).png().toBuffer();
    return sharp({
      create: {
        width: cropTotalW,
        height: cropTotalH,
        channels: 4,
        background: 'white',
      },
    })
      .composite([
        { input: croppedContent, top: LABEL_MARGIN, left: LABEL_MARGIN },
        { input: cropOverlay, top: 0, left: 0 },
      ])
      .png()
      .toBuffer();
  }

  const fullOverlay = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: 'white',
    },
  })
    .composite([
      { input: screenshotBuffer, top: LABEL_MARGIN, left: LABEL_MARGIN },
      { input: fullOverlay, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

function buildGridOverlaySvg({ contentWidth, contentHeight, cols, rows, colOffset, rowOffset }) {
  const totalW = LABEL_MARGIN + contentWidth;
  const totalH = LABEL_MARGIN + contentHeight;

  let svg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0" y="0" width="${LABEL_MARGIN}" height="${totalH}" fill="white"/>`;
  svg += `<rect x="0" y="0" width="${totalW}" height="${LABEL_MARGIN}" fill="white"/>`;

  for (let c = 0; c < cols; c += 1) {
    const x = LABEL_MARGIN + c * CELL_SIZE + CELL_SIZE / 2;
    svg += `<text x="${x}" y="35" font-size="12" text-anchor="middle" fill="#cc0000">${colLabel(colOffset + c)}</text>`;
  }

  for (let r = 0; r < rows; r += 1) {
    const y = LABEL_MARGIN + r * CELL_SIZE + CELL_SIZE / 2 + 4;
    svg += `<text x="25" y="${y}" font-size="12" text-anchor="middle" fill="#cc0000">${rowOffset + r + 1}</text>`;
  }

  for (let x = 0; x <= cols; x += 1) {
    const px = Math.min(totalW, LABEL_MARGIN + x * CELL_SIZE);
    svg += `<line x1="${px}" y1="${LABEL_MARGIN}" x2="${px}" y2="${totalH}" stroke="rgba(255,0,0,0.3)" stroke-width="1"/>`;
  }

  for (let y = 0; y <= rows; y += 1) {
    const py = Math.min(totalH, LABEL_MARGIN + y * CELL_SIZE);
    svg += `<line x1="${LABEL_MARGIN}" y1="${py}" x2="${totalW}" y2="${py}" stroke="rgba(255,0,0,0.3)" stroke-width="1"/>`;
  }

  // Add per-cell labels with dark background for deterministic readability.
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const label = `${colLabel(colOffset + c)}${rowOffset + r + 1}`;
      const boxWidth = Math.min(CELL_SIZE - 4, Math.max(22, 8 + label.length * 8));
      const boxHeight = 16;
      const boxX = LABEL_MARGIN + c * CELL_SIZE + 2;
      const boxY = LABEL_MARGIN + r * CELL_SIZE + 2;
      const textX = boxX + 3;
      const textY = boxY + 12;

      svg += `<rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="${boxHeight}" rx="2" ry="2" fill="rgba(0,0,0,0.7)"/>`;
      svg += `<text x="${textX}" y="${textY}" font-size="12" fill="#ffffff" text-anchor="start">${label}</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}

function requireSelector(value) {
  const selector = String(value || '').trim();
  if (!selector) throw new Error('selector is required.');
  return selector;
}

async function runWithOptionalNavigation(page, waitForNavigation, trigger) {
  const waitConfig = normalizeNavigationWait(waitForNavigation);
  if (!waitConfig) {
    await trigger();
    return;
  }

  const timeout = waitConfig.timeoutMs;
  const waitUntil = normalizeLoadState(waitConfig.waitUntil);
  const waitPromise = waitConfig.urlIncludes
    ? page.waitForURL((url) => String(url).includes(waitConfig.urlIncludes), { timeout, waitUntil })
    : waitConfig.urlMatches
      ? page.waitForURL(new RegExp(waitConfig.urlMatches), { timeout, waitUntil })
      : page.waitForNavigation({ waitUntil, timeout });

  await Promise.all([waitPromise, trigger()]);
}

function normalizeNavigationWait(value) {
  if (!value) return null;
  if (value === true) return { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS, waitUntil: 'domcontentloaded' };

  const timeoutMs = Number(value.timeoutMs);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS,
    waitUntil: normalizeLoadState(value.waitUntil),
    urlIncludes: typeof value.urlIncludes === 'string' && value.urlIncludes.trim() ? value.urlIncludes.trim() : undefined,
    urlMatches: typeof value.urlMatches === 'string' && value.urlMatches.trim() ? value.urlMatches.trim() : undefined,
  };
}

async function waitForOptionalLoadState(page, waitUntil, timeoutMs) {
  if (waitUntil === undefined && timeoutMs === undefined) return;
  await page.waitForLoadState(normalizeLoadState(waitUntil), {
    timeout: normalizeTimeoutMs(timeoutMs),
  });
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return parsed;
}

function normalizeTimeoutMsOrUndefined(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizeLoadState(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'load' || state === 'networkidle') return state;
  return 'domcontentloaded';
}

function normalizeSelectorWaitState(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'attached' || state === 'detached' || state === 'hidden') return state;
  return 'visible';
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeCoordinateSpace(value) {
  const mode = String(value || '').toLowerCase();
  return mode === 'page' ? 'page' : 'viewport';
}

function colLabel(index) {
  let i = index;
  let label = '';
  while (i >= 0) {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  }
  return label;
}

function parseCell(input) {
  const trimmed = String(input || '').trim().toUpperCase();
  const match = /^([A-Z]+)(\d+)$/.exec(trimmed);
  if (!match) throw new Error(`Invalid grid coordinate: ${input}`);

  const colLabelText = match[1];
  const rowText = match[2];
  let col = 0;
  for (let i = 0; i < colLabelText.length; i += 1) {
    col = col * 26 + (colLabelText.charCodeAt(i) - 64);
  }

  const row = Number.parseInt(rowText, 10);
  if (row <= 0) throw new Error(`Invalid row index in coordinate: ${input}`);

  return { col: col - 1, row: row - 1 };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed request: ${url} (${response.status})`);
  }
  return response.json();
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
