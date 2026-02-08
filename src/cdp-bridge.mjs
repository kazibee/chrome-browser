import { chromium } from 'playwright';
import sharp from 'sharp';

const CELL_SIZE = 100;
const LABEL_MARGIN = 50;
const SAMPLE_STEP = 10;

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
      await page.goto(String(payload.url || ''), { waitUntil: 'domcontentloaded' });
      result = { ok: true };
    } else if (op === 'execute') {
      const page = await getOrCreatePage(context, false);
      await runExecute(page, payload.action || {});
      result = { ok: true };
    } else if (op === 'scanZones') {
      const page = await getOrCreatePage(context, false);
      const zones = await runScanZones(page, payload.zones || []);
      result = { zones };
    } else if (op === 'gridScreenshot') {
      const page = await getOrCreatePage(context, false);
      const image = await runGridScreenshot(page, payload.start, payload.end);
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
    await page.click(selectorForKb(action.kb));
    return;
  }

  if (action.type === 'type') {
    await page.fill(selectorForKb(action.kb), '');
    await page.type(selectorForKb(action.kb), String(action.text || ''));
    return;
  }

  if (action.type === 'select') {
    await page.selectOption(selectorForKb(action.kb), String(action.value || ''));
    return;
  }

  if (action.type === 'scroll') {
    const amount = Number(action.amount || 500);
    const delta = action.direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, delta);
    return;
  }

  if (action.type === 'navigate') {
    await page.goto(String(action.url || ''), { waitUntil: 'domcontentloaded' });
    return;
  }

  throw new Error(`Unknown action type: ${String(action.type)}`);
}

async function runScanZones(page, zones) {
  return Promise.all(
    zones.map(async (zone) => {
      const start = parseCell(zone.start);
      const end = parseCell(zone.end);
      const minCol = Math.min(start.col, end.col);
      const maxCol = Math.max(start.col, end.col);
      const minRow = Math.min(start.row, end.row);
      const maxRow = Math.max(start.row, end.row);

      const elements = await page.evaluate(
        ({ minCol, maxCol, minRow, maxRow, cellSize, step }) => {
          const isInteractive = (el) => {
            const tag = el.tagName;
            if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return true;
            if (tag === 'A' && el.href) return true;
            const role = el.getAttribute('role');
            if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'combobox'].includes(role)) return true;
            if (el.hasAttribute('contenteditable')) return true;
            const tabIndex = el.getAttribute('tabindex');
            if (tabIndex !== null && Number(tabIndex) >= 0) return true;
            return window.getComputedStyle(el).cursor === 'pointer';
          };

          const getText = (el) => {
            const raw = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return raw.slice(0, 60);
          };

          const tagToken = (el, token) => {
            const existing = (el.getAttribute('data-kb') || '').trim();
            const tokens = existing ? existing.split(/\s+/) : [];
            if (!tokens.includes(token)) {
              el.setAttribute('data-kb', existing ? `${existing} ${token}` : token);
            }
          };

          const results = [];
          const seenElements = new Set();

          for (let row = minRow; row <= maxRow; row += 1) {
            for (let col = minCol; col <= maxCol; col += 1) {
              const cellName = `${toColLabel(col)}${row + 1}`;
              const foundInCell = [];

              const cellLeft = col * cellSize;
              const cellRight = (col + 1) * cellSize;
              const cellTop = row * cellSize;
              const cellBottom = (row + 1) * cellSize;

              for (let x = cellLeft + 1; x < cellRight; x += step) {
                if (x >= window.innerWidth) break;
                for (let y = cellTop + 1; y < cellBottom; y += step) {
                  if (y >= window.innerHeight) break;
                  let node = document.elementFromPoint(x, y);
                  while (node) {
                    if (isInteractive(node) && !foundInCell.includes(node)) {
                      foundInCell.push(node);
                    }
                    node = node.parentElement;
                  }
                }
              }

              foundInCell.forEach((el, idx) => {
                const token = `${cellName}:${idx}`;
                tagToken(el, token);
                if (seenElements.has(el)) return;
                seenElements.add(el);

                results.push({
                  kb: token,
                  tag: el.tagName,
                  text: getText(el),
                  placeholder: el.placeholder || undefined,
                  type: el.type || undefined,
                  role: el.getAttribute('role') || undefined,
                  label: el.getAttribute('aria-label') || undefined,
                });
              });
            }
          }

          return results;

          function toColLabel(index) {
            let i = index;
            let label = '';
            while (i >= 0) {
              label = String.fromCharCode(65 + (i % 26)) + label;
              i = Math.floor(i / 26) - 1;
            }
            return label;
          }
        },
        {
          minCol,
          maxCol,
          minRow,
          maxRow,
          cellSize: CELL_SIZE,
          step: SAMPLE_STEP,
        },
      );

      return {
        zone: `${String(zone.start || '').toUpperCase()}:${String(zone.end || '').toUpperCase()}`,
        elements,
      };
    }),
  );
}

async function runGridScreenshot(page, start, end) {
  const screenshotBuffer = await page.screenshot({ type: 'png' });
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

function selectorForKb(kb) {
  const token = String(kb || '').trim();
  if (!token) throw new Error('kb token is required.');
  return `[data-kb~="${token.replace(/(["\\])/g, '\\$1')}"]`;
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
