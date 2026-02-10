import { chromium } from 'playwright';
import sharp from 'sharp';
import * as cheerio from 'cheerio';

const CELL_SIZE = 100;
const LABEL_MARGIN = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

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
      const url = String(payload.url || '');
      const timeout = normalizeTimeoutMsOrUndefined(payload.timeoutMs);
      const requested = normalizeLoadState(payload.waitUntil);
      // Build a fallback chain: requested state -> load -> domcontentloaded.
      // De-duplicate so we never retry with the same waitUntil twice.
      const chain = [requested];
      if (requested !== 'load') chain.push('load');
      if (requested !== 'domcontentloaded') chain.push('domcontentloaded');

      let lastErr;
      for (const waitUntil of chain) {
        try {
          await page.goto(url, { waitUntil, timeout });
          lastErr = null;
          break;
        } catch (err) {
          const msg = String(err?.message || '');
          const isRetriable =
            msg.includes('Timeout') ||
            msg.includes('timeout') ||
            msg.includes('ERR_BLOCKED_BY_RESPONSE') ||
            msg.includes('net::ERR_');
          if (!isRetriable || waitUntil === chain[chain.length - 1]) {
            throw err;
          }
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      // Inject persistent observer after successful navigation so it
      // starts indexing interactive elements immediately.
      await ensureObserver(page);
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
    } else if (op === 'gridScreenshotText') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runGridScreenshotText(page, payload.start, payload.end, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else if (op === 'gridScreenshotInteractive') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runGridScreenshotInteractive(page, payload.start, payload.end, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else if (op === 'screenshotText') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runScreenshotText(page, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else if (op === 'screenshotInteractive') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runScreenshotInteractive(page, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else if (op === 'scanInteractive') {
      const page = await getOrCreatePage(context, false);
      // No load-state wait — scanInteractive reads whatever DOM exists right now.
      // The content is already there; waiting for load/networkidle causes timeouts
      // on pages with streaming resources.
      const elements = await runScanInteractive(page);
      result = { elements };
    } else if (op === 'screenshot') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const image = await runScreenshot(page, payload.start, payload.end, Boolean(payload.fullPage));
      result = { imageBase64: image.toString('base64') };
    } else if (op === 'domQuery') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const elements = await runDomQuery(page, payload);
      result = { elements };
    } else if (op === 'findAndClick') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const element = await runDomQueryFirst(page, payload.find);
      if (!element) {
        const err = classifyBridgeError(new Error(`findAndClick: no element found (mode=${payload.find.mode}, query=${payload.find.query})`));
        result = { ok: false, element: null, acted: false, error: err };
      } else {
        try {
          await page.click(element.selector);
          result = { ok: true, element, acted: true };
        } catch (clickErr) {
          if (payload.coordinateFallback && element.boundingBox) {
            try {
              const coordResult = await coordinateFallbackClick(page, element);
              result = { ok: true, element, acted: true, coordinatesUsed: coordResult };
            } catch (fallbackErr) {
              const err = classifyBridgeError(fallbackErr);
              result = { ok: false, element, acted: false, error: err };
            }
          } else {
            const err = classifyBridgeError(clickErr);
            result = { ok: false, element, acted: false, error: err };
          }
        }
      }
    } else if (op === 'findAndType') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const element = await runDomQueryFirst(page, payload.find);
      if (!element) {
        const err = classifyBridgeError(new Error(`findAndType: no element found (mode=${payload.find.mode}, query=${payload.find.query})`));
        result = { ok: false, element: null, acted: false, error: err };
      } else {
        try {
          await atomicSetValue(page, element.selector, String(payload.text || ''));
          result = { ok: true, element, acted: true };
        } catch (typeErr) {
          const err = classifyBridgeError(typeErr);
          result = { ok: false, element, acted: false, error: err };
        }
      }
    } else if (op === 'findAndSelect') {
      const page = await getOrCreatePage(context, false);
      await waitForOptionalLoadState(page, payload.waitUntil, payload.timeoutMs);
      const element = await runDomQueryFirst(page, payload.find);
      if (!element) {
        const err = classifyBridgeError(new Error(`findAndSelect: no element found (mode=${payload.find.mode}, query=${payload.find.query})`));
        result = { ok: false, element: null, acted: false, error: err };
      } else {
        try {
          await page.selectOption(element.selector, String(payload.value || ''));
          result = { ok: true, element, acted: true };
        } catch (selectErr) {
          const err = classifyBridgeError(selectErr);
          result = { ok: false, element, acted: false, error: err };
        }
      }
    } else if (op === 'verify') {
      const page = await getOrCreatePage(context, false);
      result = await runVerify(page, payload);
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

/**
 * Atomically clears and sets a value on a form element in a single evaluate call.
 * Uses native property setters to bypass framework interceptors (React, Vue, etc.).
 * Handles text inputs, textareas, contenteditable, checkbox/radio, and fallbacks.
 */
async function atomicSetValue(page, selector, value) {
  await page.$eval(selector, (el, value) => {
    if (typeof el.focus === 'function') el.focus();
    const tag = el.tagName;
    if (el.isContentEditable) {
      el.textContent = value;
    } else if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      el.checked = !!value && value !== 'false';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(
        tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    } else {
      if ('value' in el) el.value = value;
      else el.textContent = value;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
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
    await atomicSetValue(page, selector, String(action.text || ''));
    return;
  }

  if (action.type === 'select') {
    await page.selectOption(requireSelector(action.selector), String(action.value || ''));
    return;
  }

  if (action.type === 'submit') {
    const selector = requireSelector(action.selector);
    await runWithOptionalNavigation(page, action.waitForNavigation, async () => {
      const maxAttempts = 3;
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
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
          break;
        } catch (error) {
          if (!isRecoverableScanError(error) || attempt >= maxAttempts) throw error;
          lastError = error;
          await sleep(200 * attempt);
        }
      }
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

  if (action.type === 'waitForStable') {
    await waitForStableMutations(page, {
      maxMutations: action.maxMutations,
      stabilityWindowMs: action.stabilityWindowMs,
      maxObservationMs: action.maxObservationMs,
    });
    return;
  }

  if (action.type === 'waitForCustom') {
    const evaluator = String(action.evaluator || '');
    if (!evaluator) throw new Error('waitForCustom requires evaluator function.');
    await page.waitForFunction(evaluator, {
      timeout: normalizeTimeoutMs(action.timeoutMs),
    });
    return;
  }

  if (action.type === 'scrollIntoView') {
    const selector = requireSelector(action.selector);
    await page.$eval(selector, (el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(300);
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
      const result = await page.evaluate(
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

          // Shadow DOM-aware query selector that recursively traverses shadow roots
          const querySelectorAllDeep = (selector) => {
            const results = [];
            const visited = new WeakSet();

            const traverse = (root) => {
              if (!root) return;
              if (visited.has(root)) return;
              visited.add(root);

              // Query the current root (document or shadow root)
              try {
                const matches = root.querySelectorAll(selector);
                matches.forEach((el) => results.push(el));
              } catch (err) {
                // Invalid selector or DOM access error - skip this root
              }

              // Recursively traverse all shadow roots
              try {
                const allElements = root.querySelectorAll('*');
                allElements.forEach((el) => {
                  if (el.shadowRoot) {
                    try {
                      traverse(el.shadowRoot);
                    } catch (err) {
                      // Closed shadow root or access denied - skip it
                    }
                  }
                });
              } catch (err) {
                // Failed to query elements - skip traversal
              }
            };

            traverse(document);
            return results;
          };

          const results = [];
          const seenSelectors = new Set();

          // Clamp DPR to reasonable bounds [1.0, 4.0] to prevent Playwright emulation issues
          const rawDpr = Number(window.devicePixelRatio) || 1;
          const dpr = Math.max(1.0, Math.min(4.0, rawDpr));

          // Detect CSS zoom which affects coordinate mapping
          // getComputedStyle().zoom returns the effective zoom as a string (e.g., "1.5")
          const htmlZoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
          const bodyZoom = document.body ? (Number(getComputedStyle(document.body).zoom) || 1) : 1;
          const cssZoom = htmlZoom * bodyZoom;

          // Edge case handling: treat invalid zoom values as 1.0
          const safeCssZoom = (cssZoom > 0 && isFinite(cssZoom)) ? cssZoom : 1;

          const cssSpaceWidth = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollWidth) || 1)
            : Math.max(1, Number(window.innerWidth) || 1);
          const cssSpaceHeight = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollHeight) || 1)
            : Math.max(1, Number(window.innerHeight) || 1);

          // The visual grid is drawn on screenshot image pixels. Convert those zone bounds
          // back into CSS-pixel coordinates before intersecting DOM rects.
          // getBoundingClientRect() returns values AFTER CSS zoom is applied, so we must
          // account for both DPR and CSS zoom: effectiveScale = dpr * cssZoom
          const effectiveScale = dpr * safeCssZoom;
          const scaleX = effectiveScale;
          const scaleY = effectiveScale;

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
          querySelectorAllDeep(interactiveQuery).forEach((el) => candidates.add(el));

          const pointerCandidates = querySelectorAllDeep('[style*="cursor: pointer"],[style*="cursor:pointer"]');
          pointerCandidates.forEach((el) => candidates.add(el));

          candidates.forEach((el) => {
            if (!(el instanceof HTMLElement)) return;
            if (!isInteractive(el)) return;

            const rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return;

            // Check if element has fixed or sticky positioning - these don't scroll with the page
            const computedStyle = window.getComputedStyle(el);
            const position = computedStyle?.position || '';
            const shouldApplyScrollOffset = coordinateSpace === 'page' && position !== 'fixed' && position !== 'sticky';

            const rectInSpace = shouldApplyScrollOffset
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

          // Return metadata about zoom for warning purposes
          return {
            elements: results,
            cssZoom: safeCssZoom,
            htmlZoom,
            bodyZoom,
          };

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

      // Log warning if CSS zoom is detected (not equal to 1.0)
      if (result.cssZoom !== 1.0) {
        const zoomDetails = result.htmlZoom !== 1 || result.bodyZoom !== 1
          ? ` (html: ${result.htmlZoom}, body: ${result.bodyZoom})`
          : '';
        // Note: Using console.warn here as this is a standalone script without DI infrastructure
        // TODO: Migrate to logger class when script is refactored to support DI
        console.warn(`[CSS Zoom Detected] Effective zoom: ${result.cssZoom}${zoomDetails} - Coordinates adjusted automatically`);
      }

      return {
        zone: zoneName,
        elements: result.elements,
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

/**
 * Scans the entire page for interactive elements and returns each with an
 * ID-anchored CSS selector. Walks up from each element to the nearest ancestor
 * with an `id` attribute, then builds a child-combinator path back down
 * (e.g. `div#login-form > div:nth-of-type(2) > button`).
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{selector: string, tag: string, text: string, href?: string, placeholder?: string, type?: string, role?: string, label?: string}>>}
 */
async function runScanInteractive(page) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runScanInteractiveOnce(page);
    } catch (error) {
      if (!isRecoverableScanError(error) || attempt >= maxAttempts) {
        throw error;
      }
      lastError = error;
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

async function runScanInteractiveOnce(page) {
  // 1. Try the persistent shadow DOM observer — instant read, immune to churn.
  const cached = await readObserverData(page);
  if (cached) return cached;

  // 2. Observer missing or stale — inject it and wait for initial scan.
  const injected = await ensureObserver(page);
  if (injected) {
    await sleep(200); // let the initial scan + debounce complete
    const fresh = await readObserverData(page);
    if (fresh) return fresh;
  }

  // 3. Fallback: atomic HTML snapshot + offline cheerio query.
  //    This covers pages where the observer injection itself failed
  //    (e.g. CSP restrictions, context destroyed mid-inject).
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const $ = cheerio.load(html);

  const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'combobox']);

  function isInteractive(el) {
    const tag = el.tagName?.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (tag === 'a' && $(el).attr('href')) return true;
    const role = $(el).attr('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if ($(el).attr('contenteditable') !== undefined) return true;
    const tabIndex = $(el).attr('tabindex');
    if (tabIndex !== undefined && Number(tabIndex) >= 0) return true;
    if ($(el).attr('onclick') !== undefined) return true;
    return false;
  }

  function isHidden(el) {
    const $el = $(el);
    if ($el.attr('hidden') !== undefined) return true;
    if ($el.attr('aria-hidden') === 'true') return true;
    if ($el.attr('disabled') !== undefined) return true;
    const style = $el.attr('style') || '';
    if (/display\s*:\s*none/i.test(style)) return true;
    if (/visibility\s*:\s*hidden/i.test(style)) return true;
    if (/opacity\s*:\s*0(?:[;\s]|$)/.test(style)) return true;
    return false;
  }

  function getText(el) {
    const $el = $(el);
    const raw = ($el.text() || $el.attr('value') || $el.attr('placeholder') || $el.attr('aria-label') || '')
      .replace(/\s+/g, ' ').trim();
    return raw.slice(0, 60);
  }

  function escapeCss(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }

  function buildSelector(el) {
    const segments = [];
    let node = el;

    while (node && node.tagName) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') break;

      const id = $(node).attr('id');
      if (id) {
        segments.unshift(`${tag}#${escapeCss(id)}`);
        return segments.join(' > ');
      }

      const parent = $(node).parent();
      if (!parent.length || parent[0].tagName?.toLowerCase() === 'html' || parent[0].tagName?.toLowerCase() === 'body') {
        segments.unshift(tag);
      } else {
        const sameTagSiblings = parent.children(tag);
        if (sameTagSiblings.length <= 1) {
          segments.unshift(tag);
        } else {
          const position = sameTagSiblings.index(node) + 1;
          segments.unshift(`${tag}:nth-of-type(${position})`);
        }
      }

      node = parent[0];
    }

    return segments.length ? `html > ${segments.join(' > ')}` : '';
  }

  const interactiveSelector =
    'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable],[onclick]';
  const candidates = new Set();
  $(interactiveSelector).each((_, el) => candidates.add(el));

  const elements = [];
  const seenSelectors = new Set();

  for (const el of candidates) {
    if (!isInteractive(el)) continue;
    if (isHidden(el)) continue;

    const selector = buildSelector(el);
    if (!selector || seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    const $el = $(el);
    const tag = el.tagName?.toLowerCase();

    elements.push({
      selector,
      tag: (tag || '').toUpperCase(),
      text: getText(el),
      href: tag === 'a' ? $el.attr('href') || undefined : undefined,
      placeholder: $el.attr('placeholder') || undefined,
      type: $el.attr('type') || undefined,
      role: $el.attr('role') || undefined,
      label: $el.attr('aria-label') || undefined,
    });
  }

  elements.sort((a, b) => {
    const aText = (a.text || '').toLowerCase();
    const bText = (b.text || '').toLowerCase();
    if (aText && bText) return aText.localeCompare(bText);
    if (aText) return -1;
    if (bText) return 1;
    return a.selector.localeCompare(b.selector);
  });

  return elements;
}

/**
 * Classifies a bridge error into one of four tiers:
 *   A (Transient)  — context/frame/browser gone; immediate retry likely succeeds
 *   B (Stale)      — element detached/hidden/blocked; re-find the element
 *   C (Navigation) — page navigated away; caller may need to re-navigate
 *   D (Permanent)  — invalid selector, timeout, not found; fail immediately
 *
 * Returns { tier, code, message, rawMessage, retryable, retryStrategy }.
 */
function classifyBridgeError(error) {
  const rawMessage = String(error && error.message ? error.message : error);

  // --- Tier A: Transient ---
  if (rawMessage.includes('Execution context was destroyed') ||
      rawMessage.includes('Cannot find context with specified id')) {
    return { tier: 'A', code: 'CONTEXT_DESTROYED', message: 'Execution context was destroyed', rawMessage, retryable: true, retryStrategy: 'immediate' };
  }
  if (rawMessage.includes('Frame was detached') ||
      rawMessage.includes('frame was detached')) {
    return { tier: 'A', code: 'FRAME_DETACHED', message: 'Frame was detached', rawMessage, retryable: true, retryStrategy: 'immediate' };
  }
  if (rawMessage.includes('Target page, context or browser has been closed') ||
      rawMessage.includes('Browser has been closed') ||
      rawMessage.includes('browser has been closed')) {
    return { tier: 'A', code: 'BROWSER_CLOSED', message: 'Browser or context has been closed', rawMessage, retryable: true, retryStrategy: 'immediate' };
  }

  // --- Tier B: Stale ---
  if (rawMessage.includes('Element is not attached to the DOM') ||
      rawMessage.includes('is not attached to the DOM')) {
    return { tier: 'B', code: 'ELEMENT_DETACHED', message: 'Element is not attached to the DOM', rawMessage, retryable: true, retryStrategy: 'refind' };
  }
  if (rawMessage.includes('Element is not visible') ||
      rawMessage.includes('element is not visible')) {
    return { tier: 'B', code: 'ELEMENT_NOT_VISIBLE', message: 'Element is not visible', rawMessage, retryable: true, retryStrategy: 'refind' };
  }
  if (rawMessage.includes('Element is not interactable') ||
      rawMessage.includes('element is not interactable') ||
      rawMessage.includes('intercepts pointer events') ||
      rawMessage.includes('Element is outside of the viewport')) {
    return { tier: 'B', code: 'ELEMENT_NOT_INTERACTABLE', message: 'Element is not interactable', rawMessage, retryable: true, retryStrategy: 'refind' };
  }

  // --- Tier C: Navigation ---
  if (rawMessage.includes('Navigation interrupted') ||
      rawMessage.includes('Navigating frame was detached') ||
      rawMessage.includes('navigation was interrupted')) {
    return { tier: 'C', code: 'PAGE_NAVIGATED', message: 'Navigation interrupted the operation', rawMessage, retryable: false, retryStrategy: 'renavigate' };
  }
  if (rawMessage.includes('cross-origin') ||
      rawMessage.includes('Cross-origin')) {
    return { tier: 'C', code: 'CROSS_ORIGIN_NAVIGATION', message: 'Cross-origin navigation occurred', rawMessage, retryable: false, retryStrategy: 'renavigate' };
  }

  // --- Tier D: Permanent ---
  if (rawMessage.includes('Timeout') || rawMessage.includes('timeout')) {
    return { tier: 'D', code: 'TIMEOUT', message: 'Operation timed out', rawMessage, retryable: false, retryStrategy: 'fail' };
  }
  if (rawMessage.includes('is not a valid selector') ||
      rawMessage.includes('Failed to execute \'querySelector\'')) {
    return { tier: 'D', code: 'SELECTOR_INVALID', message: 'Invalid selector', rawMessage, retryable: false, retryStrategy: 'fail' };
  }
  if (rawMessage.includes('No node found for selector') ||
      rawMessage.includes('no element found') ||
      rawMessage.includes('No element found')) {
    return { tier: 'D', code: 'ELEMENT_NOT_FOUND', message: 'Element not found', rawMessage, retryable: false, retryStrategy: 'fail' };
  }

  // Unknown — treat as permanent
  return { tier: 'D', code: 'UNKNOWN', message: rawMessage, rawMessage, retryable: false, retryStrategy: 'fail' };
}

function isRecoverableScanError(error) {
  const c = classifyBridgeError(error);
  return c.tier === 'A' || c.tier === 'B';
}

async function waitForStableDom(page) {
  try {
    await waitForStableMutations(page, {
      maxMutations: 50,
      stabilityWindowMs: 200,
      maxObservationMs: 2000,
    });
  } catch {
    // Ignore and proceed; some pages stream updates continuously.
  }
}

async function waitForStableMutations(page, options = {}) {
  const maxMutations = options.maxMutations ?? 50;
  const stabilityWindowMs = options.stabilityWindowMs ?? 200;
  const maxObservationMs = options.maxObservationMs ?? 2000;

  await page.evaluate(
    ({ maxMutations, stabilityWindowMs, maxObservationMs }) => {
      return new Promise((resolve) => {
        let mutationCount = 0;
        let stabilityTimer = null;
        let maxTimer = null;

        const cleanup = (observer) => {
          if (observer) observer.disconnect();
          if (stabilityTimer) clearTimeout(stabilityTimer);
          if (maxTimer) clearTimeout(maxTimer);
        };

        const observer = new MutationObserver(() => {
          mutationCount++;

          if (mutationCount >= maxMutations) {
            cleanup(observer);
            resolve();
            return;
          }

          if (stabilityTimer) clearTimeout(stabilityTimer);
          stabilityTimer = setTimeout(() => {
            cleanup(observer);
            resolve();
          }, stabilityWindowMs);
        });

        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        maxTimer = setTimeout(() => {
          cleanup(observer);
          resolve();
        }, maxObservationMs);

        stabilityTimer = setTimeout(() => {
          cleanup(observer);
          resolve();
        }, stabilityWindowMs);
      });
    },
    { maxMutations, stabilityWindowMs, maxObservationMs },
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shadow DOM Observer — persistent, churn-proof interactive element index
// ---------------------------------------------------------------------------
// Injects a hidden <div> outside framework-managed DOM that runs a
// MutationObserver. On every DOM mutation (debounced) it re-scans for
// interactive elements and caches the result as a JSON data attribute.
// SPA frameworks never touch this element because it lives outside their
// virtual DOM tree and is encapsulated via closed shadow DOM.
// ---------------------------------------------------------------------------

const KB_OBSERVER_ID = '__kb_observer__';
const OBSERVER_MAX_AGE_MS = 5000;

/**
 * Browser-side script that injects (or no-ops if already present) the
 * persistent interactive-element observer.  Returns 'exists' | 'injected'.
 */
const KB_OBSERVER_SCRIPT = `(function() {
  if (document.getElementById('${KB_OBSERVER_ID}')) return 'exists';

  var INTERACTIVE_SELECTOR =
    'a[href],button,input,select,textarea,summary,' +
    '[role],[tabindex],[contenteditable],[onclick]';
  var INTERACTIVE_TAGS = {BUTTON:1,INPUT:1,SELECT:1,TEXTAREA:1,SUMMARY:1};
  var INTERACTIVE_ROLES = {button:1,link:1,checkbox:1,radio:1,menuitem:1,tab:1,switch:1,combobox:1};

  function isInteractive(el) {
    if (INTERACTIVE_TAGS[el.tagName]) return true;
    if (el.tagName === 'A' && el.hasAttribute('href')) return true;
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES[role]) return true;
    if (el.hasAttribute('contenteditable')) return true;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    if (el.hasAttribute('onclick')) return true;
    return false;
  }

  function isHidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.disabled) return true;
    try {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (Number(cs.opacity) === 0) return true;
    } catch(e) {}
    return false;
  }

  function getText(el) {
    var raw = (el.textContent || el.value || el.placeholder ||
               el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    return raw.slice(0, 60);
  }

  function escapeCss(v) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(v));
    return String(v).replace(/[^a-zA-Z0-9_-]/g, function(c){ return '\\\\'+c; });
  }

  function buildSelector(el) {
    var segs = [], node = el;
    while (node && node.tagName) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') break;
      var id = node.id;
      if (id) { segs.unshift(tag+'#'+escapeCss(id)); return segs.join(' > '); }
      var parent = node.parentElement;
      if (!parent || parent.tagName === 'HTML' || parent.tagName === 'BODY') {
        segs.unshift(tag);
      } else {
        var sibs = Array.from(parent.children).filter(function(c){ return c.tagName === node.tagName; });
        if (sibs.length <= 1) { segs.unshift(tag); }
        else { segs.unshift(tag+':nth-of-type('+(sibs.indexOf(node)+1)+')'); }
      }
      node = parent;
    }
    return segs.length ? segs.join(' > ') : '';
  }

  function scan() {
    var all = document.querySelectorAll(INTERACTIVE_SELECTOR);
    var elems = [], seen = {};
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isInteractive(el)) continue;
      if (isHidden(el)) continue;
      var sel = buildSelector(el);
      if (!sel || seen[sel]) continue;
      seen[sel] = 1;
      var tag = el.tagName;
      elems.push({
        selector: sel,
        tag: tag,
        text: getText(el),
        href: tag === 'A' ? (el.getAttribute('href') || undefined) : undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined,
        label: el.getAttribute('aria-label') || undefined
      });
    }
    elems.sort(function(a, b) {
      var at = (a.text||'').toLowerCase(), bt = (b.text||'').toLowerCase();
      if (at && bt) return at < bt ? -1 : at > bt ? 1 : 0;
      if (at) return -1;
      if (bt) return 1;
      return a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0;
    });
    return elems;
  }

  var host = document.createElement('div');
  host.id = '${KB_OBSERVER_ID}';
  host.style.cssText = 'display:none!important;position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  host.attachShadow({ mode: 'closed' });

  var debounceTimer = null;
  var MAX_DEFERRAL_MS = 500;
  var firstPendingMutationTs = null;

  function doScan() {
    try {
      host.dataset.scan = JSON.stringify(scan());
      host.dataset.ts = String(Date.now());
    } catch(e) { /* keep previous data */ }
    firstPendingMutationTs = null;
  }

  var obs = new MutationObserver(function() {
    var now = Date.now();
    if (firstPendingMutationTs === null) {
      firstPendingMutationTs = now;
    }
    if (now - firstPendingMutationTs >= MAX_DEFERRAL_MS) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      doScan();
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doScan, 150);
  });

  document.documentElement.appendChild(host);
  doScan();
  obs.observe(document.body || document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden','disabled','aria-hidden','style','class','role','tabindex','href']
  });

  return 'injected';
})()`;

/**
 * Injects the persistent observer into the page if not already present.
 * Fails silently — observer is an optimization, not a hard requirement.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if observer is available on the page.
 */
async function ensureObserver(page) {
  try {
    const status = await page.evaluate(KB_OBSERVER_SCRIPT);
    return status === 'exists' || status === 'injected';
  } catch {
    return false;
  }
}

/**
 * Reads cached interactive-element data from the observer.
 * Returns null if observer is missing, data is stale, or read fails.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array|null>}
 */
async function readObserverData(page) {
  try {
    const raw = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el || !el.dataset.scan) return null;
      return { data: el.dataset.scan, ts: Number(el.dataset.ts || 0) };
    }, KB_OBSERVER_ID);
    if (!raw || !raw.data) return null;
    const age = Date.now() - raw.ts;
    if (age > OBSERVER_MAX_AGE_MS) return null;
    return JSON.parse(raw.data);
  } catch {
    return null;
  }
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * Ensures the page has a non-zero viewport. CDP-connected pages (about:blank,
 * minimized windows, headless with no viewport) can report 0x0, which causes
 * Playwright's screenshot to fail with "Cannot take screenshot with 0 width."
 * @param {import('playwright').Page} page
 */
async function ensureViewportSize(page) {
  const size = page.viewportSize();
  if (!size || size.width <= 0 || size.height <= 0) {
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
}

/**
 * Captures a PNG screenshot via Playwright and validates that its pixel
 * dimensions match the expected DPR-scaled values.
 * @param {import('playwright').Page} page - Playwright page instance.
 * @param {boolean} fullPage - Capture the full scrollable page instead of the viewport.
 * @returns {Promise<{screenshotBuffer: Buffer, width: number, height: number, dpr: number}>}
 */
async function captureAndValidateScreenshot(page, fullPage) {
  await ensureViewportSize(page);
  const screenshotBuffer = await page.screenshot({ type: 'png', fullPage, scale: 'device' });
  const metadata = await sharp(screenshotBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (!width || !height) {
    throw new Error('Failed to determine screenshot dimensions.');
  }

  // Validate screenshot dimensions match expected DPR scaling
  // For fullPage mode, validate against document dimensions; for viewport mode, use window dimensions
  const dimensions = await page.evaluate((isFullPage) => {
    const rawDpr = Number(window.devicePixelRatio) || 1;
    const dpr = Math.max(1.0, Math.min(4.0, rawDpr));

    const cssWidth = isFullPage
      ? Math.max(1, Number(document.documentElement.scrollWidth) || 1)
      : Math.max(1, Number(window.innerWidth) || 1);
    const cssHeight = isFullPage
      ? Math.max(1, Number(document.documentElement.scrollHeight) || 1)
      : Math.max(1, Number(window.innerHeight) || 1);

    return {
      dpr,
      cssWidth,
      cssHeight,
      mode: isFullPage ? 'fullPage' : 'viewport',
    };
  }, fullPage);

  // If CSS viewport reports implausibly small dimensions (e.g. about:blank, minimized,
  // or page not yet loaded), skip DPR validation and derive DPR from actual screenshot size.
  const MIN_PLAUSIBLE_CSS = 10;
  if (dimensions.cssWidth < MIN_PLAUSIBLE_CSS && dimensions.cssHeight < MIN_PLAUSIBLE_CSS) {
    const inferredDpr = dimensions.dpr;
    return { screenshotBuffer, width, height, dpr: inferredDpr };
  }

  const expectedWidth = Math.round(dimensions.cssWidth * dimensions.dpr);
  const expectedHeight = Math.round(dimensions.cssHeight * dimensions.dpr);
  const widthDiff = Math.abs(width - expectedWidth);
  const heightDiff = Math.abs(height - expectedHeight);

  if (widthDiff > 2 || heightDiff > 2) {
    throw new Error(
      `Screenshot dimension mismatch indicates Playwright DPR emulation issue. ` +
      `Expected ${expectedWidth}x${expectedHeight} (CSS ${dimensions.cssWidth}x${dimensions.cssHeight} * DPR ${dimensions.dpr}, mode: ${dimensions.mode}), ` +
      `but got ${width}x${height}. Difference: ${widthDiff}x${heightDiff}px. ` +
      `This usually means Playwright's deviceScaleFactor is not being applied correctly.`
    );
  }

  return { screenshotBuffer, width, height, dpr: dimensions.dpr };
}

/**
 * Applies the standard grid overlay (with LABEL_MARGIN) onto a base image buffer.
 * Optionally crops to a grid range before applying the overlay.
 * @param {Buffer} baseImageBuffer - Pre-composed base image (same pixel size as the screenshot).
 * @param {number} width - Image width in pixels.
 * @param {number} height - Image height in pixels.
 * @param {string} [start] - Optional crop start cell (e.g. "A1").
 * @param {string} [end] - Optional crop end cell (e.g. "C3").
 * @returns {Promise<Buffer>} PNG buffer with grid overlay composited.
 */
async function applyGridOverlay(baseImageBuffer, width, height, start, end) {
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

    const croppedContent = await sharp(baseImageBuffer)
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
      { input: baseImageBuffer, top: LABEL_MARGIN, left: LABEL_MARGIN },
      { input: fullOverlay, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Clamps bounding boxes to fit within image bounds and discards zero-size results.
 * @param {Array<{left: number, top: number, width: number, height: number}>} boxes
 * @param {number} imageWidth - Image width in pixels.
 * @param {number} imageHeight - Image height in pixels.
 * @returns {Array<{left: number, top: number, width: number, height: number}>}
 */
function clampBoxes(boxes, imageWidth, imageHeight) {
  const clamped = [];
  for (const box of boxes) {
    const left = Math.max(0, Math.min(box.left, imageWidth));
    const top = Math.max(0, Math.min(box.top, imageHeight));
    const right = Math.max(left, Math.min(box.left + box.width, imageWidth));
    const bottom = Math.max(top, Math.min(box.top + box.height, imageHeight));
    const width = right - left;
    const height = bottom - top;
    if (width > 0 && height > 0) {
      clamped.push({ left, top, width, height });
    }
  }
  return clamped;
}

/**
 * Extracts cropped regions from a screenshot buffer, ready for Sharp composite.
 * @param {Buffer} screenshotBuffer - Raw PNG screenshot buffer.
 * @param {Array<{left: number, top: number, width: number, height: number}>} boxes - Clamped bounding boxes.
 * @returns {Promise<Array<{input: Buffer, top: number, left: number}>>}
 */
async function extractRegions(screenshotBuffer, boxes) {
  return Promise.all(
    boxes.map(async (box) => {
      const regionBuffer = await sharp(screenshotBuffer)
        .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
        .png()
        .toBuffer();
      return { input: regionBuffer, top: box.top, left: box.left };
    }),
  );
}

async function runGridScreenshot(page, start, end, fullPage = false) {
  const { screenshotBuffer, width, height } = await captureAndValidateScreenshot(page, fullPage);
  return applyGridOverlay(screenshotBuffer, width, height, start, end);
}

/**
 * Walks text nodes in the DOM and returns bounding boxes of their meaningful
 * containers (paragraphs, headings, list items, etc.) in image-pixel space.
 * Recurses into open shadow roots. Skips oversized layout wrappers.
 * @param {import('playwright').Page} page
 * @param {boolean} fullPage - Whether to use page-level (scrolled) coordinates.
 * @returns {Promise<Array<{left: number, top: number, width: number, height: number}>>}
 */
async function collectTextBoxesOnce(page, fullPage) {
  return page.evaluate((isFullPage) => {
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);

    const PRIMARY_CONTAINERS = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'LI', 'TD', 'TH', 'CAPTION', 'LABEL', 'LEGEND', 'FIGCAPTION',
      'BLOCKQUOTE', 'PRE', 'CODE', 'DT', 'DD', 'SUMMARY',
      'SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'MARK', 'SMALL', 'TIME',
    ]);

    const ACCEPTABLE_CONTAINERS = new Set([
      'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'MAIN',
    ]);

    const rawDpr = Number(window.devicePixelRatio) || 1;
    const dpr = Math.max(1.0, Math.min(4.0, rawDpr));
    const htmlZoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const bodyZoom = document.body ? (Number(getComputedStyle(document.body).zoom) || 1) : 1;
    const cssZoom = htmlZoom * bodyZoom;
    const safeCssZoom = (cssZoom > 0 && isFinite(cssZoom)) ? cssZoom : 1;
    const effectiveScale = dpr * safeCssZoom;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sizeThresholdW = vw * 0.8;
    const sizeThresholdH = vh * 0.8;

    const seen = new Set();
    const boxes = [];

    function findMeaningfulContainer(textNode) {
      let node = textNode.parentElement;
      while (node) {
        const tag = node.tagName;
        if (tag === 'HTML' || tag === 'BODY') return null;
        if (SKIP_TAGS.has(tag)) return null;

        if (PRIMARY_CONTAINERS.has(tag)) return node;

        if (ACCEPTABLE_CONTAINERS.has(tag)) {
          const rect = node.getBoundingClientRect();
          if (rect.width < sizeThresholdW && rect.height < sizeThresholdH) {
            return node;
          }
        }

        node = node.parentElement;
      }
      return null;
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    }

    function processRoot(root) {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            const text = node.textContent;
            if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );

      let textNode;
      while ((textNode = walker.nextNode())) {
        const container = findMeaningfulContainer(textNode);
        if (!container) continue;
        if (seen.has(container)) continue;
        seen.add(container);

        if (!isVisible(container)) continue;

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const style = window.getComputedStyle(container);
        const position = style.position;
        const shouldApplyScrollOffset =
          isFullPage && position !== 'fixed' && position !== 'sticky';

        const cssLeft = shouldApplyScrollOffset ? rect.left + window.scrollX : rect.left;
        const cssTop = shouldApplyScrollOffset ? rect.top + window.scrollY : rect.top;

        boxes.push({
          left: Math.round(cssLeft * effectiveScale),
          top: Math.round(cssTop * effectiveScale),
          width: Math.round(rect.width * effectiveScale),
          height: Math.round(rect.height * effectiveScale),
        });
      }

      // Recurse into open shadow roots
      try {
        const allElements = root.querySelectorAll('*');
        allElements.forEach((el) => {
          if (el.shadowRoot) {
            try {
              processRoot(el.shadowRoot);
            } catch (err) {
              // Closed shadow root or access denied — skip
            }
          }
        });
      } catch (err) {
        // Failed to query elements — skip
      }
    }

    if (document.body) {
      processRoot(document.body);
    }

    return boxes;
  }, fullPage);
}

async function collectTextBoxes(page, fullPage) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await collectTextBoxesOnce(page, fullPage);
    } catch (error) {
      if (!isRecoverableScanError(error) || attempt >= maxAttempts) throw error;
      lastError = error;
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

/**
 * Captures a text-only screenshot with grid overlay. Text-containing regions
 * are cropped from the raw screenshot and pasted onto a white canvas.
 * @param {import('playwright').Page} page
 * @param {string} [start] - Optional crop start cell.
 * @param {string} [end] - Optional crop end cell.
 * @param {boolean} [fullPage=false]
 * @returns {Promise<Buffer>} PNG buffer.
 */
async function runGridScreenshotText(page, start, end, fullPage = false) {
  const { screenshotBuffer, width, height } = await captureAndValidateScreenshot(page, fullPage);
  const textBoxes = await collectTextBoxes(page, fullPage);
  const clamped = clampBoxes(textBoxes, width, height);
  const regions = await extractRegions(screenshotBuffer, clamped);
  const canvas = sharp({
    create: { width, height, channels: 4, background: 'white' },
  });
  const baseCanvas = regions.length > 0
    ? await canvas.composite(regions.map(r => ({ input: r.input, top: r.top, left: r.left }))).png().toBuffer()
    : await canvas.png().toBuffer();
  return applyGridOverlay(baseCanvas, width, height, start, end);
}

/**
 * Collects bounding boxes of interactive elements (buttons, links, inputs,
 * ARIA roles, focusable elements) in image-pixel space. Traverses shadow DOMs.
 * Filters out hidden and disabled elements.
 * @param {import('playwright').Page} page
 * @param {boolean} fullPage - Whether to use page-level (scrolled) coordinates.
 * @returns {Promise<Array<{left: number, top: number, width: number, height: number}>>}
 */
async function collectInteractiveBoxesOnce(page, fullPage) {
  return page.evaluate((isFullPage) => {
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

    const querySelectorAllDeep = (selector) => {
      const results = [];
      const visited = new WeakSet();

      const traverse = (root) => {
        if (!root) return;
        if (visited.has(root)) return;
        visited.add(root);

        try {
          const matches = root.querySelectorAll(selector);
          matches.forEach((el) => results.push(el));
        } catch (err) {
          // Invalid selector or DOM access error - skip this root
        }

        try {
          const allElements = root.querySelectorAll('*');
          allElements.forEach((el) => {
            if (el.shadowRoot) {
              try {
                traverse(el.shadowRoot);
              } catch (err) {
                // Closed shadow root or access denied - skip it
              }
            }
          });
        } catch (err) {
          // Failed to query elements - skip traversal
        }
      };

      traverse(document);
      return results;
    };

    const rawDpr = Number(window.devicePixelRatio) || 1;
    const dpr = Math.max(1.0, Math.min(4.0, rawDpr));

    const htmlZoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const bodyZoom = document.body ? (Number(getComputedStyle(document.body).zoom) || 1) : 1;
    const cssZoom = htmlZoom * bodyZoom;
    const safeCssZoom = (cssZoom > 0 && isFinite(cssZoom)) ? cssZoom : 1;
    const effectiveScale = dpr * safeCssZoom;

    const candidates = new Set();
    const interactiveQuery =
      'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable],[onclick]';
    querySelectorAllDeep(interactiveQuery).forEach((el) => candidates.add(el));

    const pointerCandidates = querySelectorAllDeep('[style*="cursor: pointer"],[style*="cursor:pointer"]');
    pointerCandidates.forEach((el) => candidates.add(el));

    const boxes = [];
    candidates.forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (!isInteractive(el)) return;

      const computedStyle = window.getComputedStyle(el);
      if (computedStyle.display === 'none') return;
      if (computedStyle.visibility === 'hidden') return;
      if (Number(computedStyle.opacity) === 0) return;
      if (el.disabled) return;

      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      const position = computedStyle.position || '';
      const shouldApplyScrollOffset = isFullPage && position !== 'fixed' && position !== 'sticky';

      const cssLeft = shouldApplyScrollOffset ? rect.left + window.scrollX : rect.left;
      const cssTop = shouldApplyScrollOffset ? rect.top + window.scrollY : rect.top;

      const left = Math.round(cssLeft * effectiveScale);
      const top = Math.round(cssTop * effectiveScale);
      const width = Math.round(rect.width * effectiveScale);
      const height = Math.round(rect.height * effectiveScale);

      boxes.push({ left, top, width, height });
    });

    return boxes;
  }, fullPage);
}

async function collectInteractiveBoxes(page, fullPage) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await collectInteractiveBoxesOnce(page, fullPage);
    } catch (error) {
      if (!isRecoverableScanError(error) || attempt >= maxAttempts) throw error;
      lastError = error;
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

/**
 * Captures an interactive-elements-only screenshot with grid overlay.
 * Interactive elements are cropped from the raw screenshot and pasted onto a white canvas.
 * @param {import('playwright').Page} page
 * @param {string} [start] - Optional crop start cell.
 * @param {string} [end] - Optional crop end cell.
 * @param {boolean} [fullPage=false]
 * @returns {Promise<Buffer>} PNG buffer.
 */
async function runGridScreenshotInteractive(page, start, end, fullPage = false) {
  const { screenshotBuffer, width, height } = await captureAndValidateScreenshot(page, fullPage);
  const interactiveBoxes = await collectInteractiveBoxes(page, fullPage);
  const clamped = clampBoxes(interactiveBoxes, width, height);
  const regions = await extractRegions(screenshotBuffer, clamped);
  const canvas = sharp({
    create: { width, height, channels: 4, background: 'white' },
  });
  const baseCanvas = regions.length > 0
    ? await canvas.composite(regions.map(r => ({ input: r.input, top: r.top, left: r.left }))).png().toBuffer()
    : await canvas.png().toBuffer();
  return applyGridOverlay(baseCanvas, width, height, start, end);
}

/**
 * Captures a clean text-only screenshot WITHOUT grid overlay.
 * Text-containing regions are cropped from the raw screenshot and pasted onto a white canvas.
 * @param {import('playwright').Page} page
 * @param {boolean} [fullPage=false]
 * @returns {Promise<Buffer>} PNG buffer.
 */
async function runScreenshotText(page, fullPage = false) {
  const { screenshotBuffer, width, height } = await captureAndValidateScreenshot(page, fullPage);
  const textBoxes = await collectTextBoxes(page, fullPage);
  const clamped = clampBoxes(textBoxes, width, height);
  const regions = await extractRegions(screenshotBuffer, clamped);
  const canvas = sharp({
    create: { width, height, channels: 4, background: 'white' },
  });
  return regions.length > 0
    ? canvas.composite(regions.map(r => ({ input: r.input, top: r.top, left: r.left }))).png().toBuffer()
    : canvas.png().toBuffer();
}

/**
 * Captures a clean interactive-elements-only screenshot WITHOUT grid overlay.
 * Interactive elements are cropped from the raw screenshot and pasted onto a white canvas.
 * @param {import('playwright').Page} page
 * @param {boolean} [fullPage=false]
 * @returns {Promise<Buffer>} PNG buffer.
 */
async function runScreenshotInteractive(page, fullPage = false) {
  const { screenshotBuffer, width, height } = await captureAndValidateScreenshot(page, fullPage);
  const interactiveBoxes = await collectInteractiveBoxes(page, fullPage);
  const clamped = clampBoxes(interactiveBoxes, width, height);
  const regions = await extractRegions(screenshotBuffer, clamped);
  const canvas = sharp({
    create: { width, height, channels: 4, background: 'white' },
  });
  return regions.length > 0
    ? canvas.composite(regions.map(r => ({ input: r.input, top: r.top, left: r.left }))).png().toBuffer()
    : canvas.png().toBuffer();
}

async function runScreenshot(page, start, end, fullPage = false) {
  await ensureViewportSize(page);
  // When cropping to a specific range, force fullPage capture so page-level
  // coordinates (from element gridRange) are always within image bounds.
  const captureFullPage = (start && end) ? true : fullPage;
  const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: captureFullPage, scale: 'device' });

  if (start && end) {
    const metadata = await sharp(screenshotBuffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (!width || !height) {
      throw new Error('Failed to determine screenshot dimensions.');
    }

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

    return sharp(screenshotBuffer)
      .extract({
        left: contentLeft,
        top: contentTop,
        width: cropWidth,
        height: cropHeight,
      })
      .png()
      .toBuffer();
  }

  return screenshotBuffer;
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

  // Capture URL before the action to detect SPA-style navigations
  // (history.pushState) that Playwright's waitForNavigation may miss.
  const urlBefore = page.url();

  const waitPromise = waitConfig.urlIncludes
    ? page.waitForURL((url) => String(url).includes(waitConfig.urlIncludes), { timeout, waitUntil })
    : waitConfig.urlMatches
      ? page.waitForURL(new RegExp(waitConfig.urlMatches), { timeout, waitUntil })
      : page.waitForNavigation({ waitUntil, timeout });

  try {
    await Promise.all([waitPromise, trigger()]);
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.includes('Timeout') && !message.includes('timeout')) {
      throw error;
    }
    // Navigation timed out — check if the URL changed (SPA route transition)
    // or if the page is in a ready state despite no traditional navigation event.
    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
      // URL changed (SPA navigation) — the click worked, swallow the timeout.
      return;
    }
    // URL didn't change — check if a specific URL was expected
    if (waitConfig.urlIncludes || waitConfig.urlMatches) {
      throw error;
    }
    // Generic waitForNavigation with no URL expectation — the click likely
    // triggered a non-navigating action (modal, toggle, AJAX). Succeed silently
    // since the click itself completed.
    return;
  }
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

// ============================================================================
// DOM Helper Functions
// ============================================================================
// These helper functions are extracted from scanZones for reusability across
// DOM-first query operations. They provide Shadow DOM traversal, accessibility
// tree heuristics, and multi-source text extraction.

/**
 * Recursively queries all elements matching a CSS selector, traversing shadow DOMs.
 * Handles both open and closed shadow roots where accessible.
 *
 * @param {Document | ShadowRoot} root - The root element to start traversal from
 * @param {string} selector - CSS selector to match
 * @returns {Element[]} Array of matching elements across all shadow boundaries
 */
function querySelectorAllDeepBrowser(root, selector) {
  const results = [];
  const visited = new WeakSet();

  const traverse = (currentRoot) => {
    if (!currentRoot) return;
    if (visited.has(currentRoot)) return;
    visited.add(currentRoot);

    // Query the current root (document or shadow root)
    try {
      const matches = currentRoot.querySelectorAll(selector);
      matches.forEach((el) => results.push(el));
    } catch (err) {
      // Invalid selector or DOM access error - skip this root
    }

    // Recursively traverse all shadow roots
    try {
      const allElements = currentRoot.querySelectorAll('*');
      allElements.forEach((el) => {
        if (el.shadowRoot) {
          try {
            traverse(el.shadowRoot);
          } catch (err) {
            // Closed shadow root or access denied - skip it
          }
        }
      });
    } catch (err) {
      // Failed to query elements - skip traversal
    }
  };

  traverse(root);
  return results;
}

/**
 * Determines if an element is interactive based on tag, role, and attributes.
 * Uses accessibility tree heuristics to identify focusable/clickable elements.
 *
 * @param {Element} el - The element to check
 * @returns {boolean} True if element is interactive
 */
function isInteractiveBrowser(el) {
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
}

/**
 * Extracts visible text from an element using multiple sources.
 * Checks innerText, value, placeholder, and aria-label in priority order.
 *
 * @param {Element} el - The element to extract text from
 * @returns {string} Extracted text (max 60 chars, whitespace normalized)
 */
function getTextBrowser(el) {
  const raw = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 60);
}

/**
 * Gets the accessible name of an element following ARIA specification.
 * Checks aria-label, aria-labelledby, associated <label> elements, and fallback text.
 *
 * @param {Element} el - The element to get accessible name for
 * @returns {string} The accessible name of the element
 */
function getAccessibleNameBrowser(el) {
  // Priority 1: aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  // Priority 2: aria-labelledby (reference to other element's text)
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const referencedEl = document.getElementById(labelledBy.trim());
    if (referencedEl) {
      return (referencedEl.innerText || referencedEl.textContent || '').trim();
    }
  }

  // Priority 3: Associated <label> element (for form inputs)
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) {
      return (label.innerText || label.textContent || '').trim();
    }
  }

  // Priority 4: Implicit label (input wrapped in label)
  const parentLabel = el.closest('label');
  if (parentLabel) {
    // Get label text excluding nested input text
    const clone = parentLabel.cloneNode(true);
    const nestedInputs = clone.querySelectorAll('input, select, textarea');
    nestedInputs.forEach((input) => input.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  // Priority 5: placeholder attribute (common for inputs)
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) {
    return placeholder.trim();
  }

  // Priority 6: title attribute
  const title = el.getAttribute('title');
  if (title && title.trim()) {
    return title.trim();
  }

  // Fallback: visible text content
  return (el.innerText || el.textContent || '').trim();
}

/**
 * Checks if an element matches a given ARIA role.
 * Handles both explicit role attributes and implicit semantic roles.
 *
 * @param {Element} el - The element to check
 * @param {string} role - The role to match against
 * @returns {boolean} True if element matches the role
 */
function matchesRoleBrowser(el, role) {
  const normalizedRole = String(role || '').toLowerCase().trim();
  if (!normalizedRole) return false;

  // Check explicit role attribute
  const explicitRole = el.getAttribute('role');
  if (explicitRole && explicitRole.toLowerCase() === normalizedRole) {
    return true;
  }

  // Check implicit semantic roles based on HTML element
  const tag = el.tagName.toLowerCase();
  const implicitRoles = {
    button: ['button'],
    a: ['link'],
    input: ['textbox', 'checkbox', 'radio', 'button', 'searchbox'],
    select: ['combobox', 'listbox'],
    textarea: ['textbox'],
    img: ['img', 'image'],
    nav: ['navigation'],
    main: ['main'],
    header: ['banner'],
    footer: ['contentinfo'],
    aside: ['complementary'],
    section: ['region'],
    article: ['article'],
    form: ['form'],
    table: ['table'],
    ul: ['list'],
    ol: ['list'],
    li: ['listitem'],
    h1: ['heading'],
    h2: ['heading'],
    h3: ['heading'],
    h4: ['heading'],
    h5: ['heading'],
    h6: ['heading'],
    dialog: ['dialog'],
    summary: ['button'],
  };

  // Special handling for input types
  if (tag === 'input') {
    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
    const inputTypeRoles = {
      button: ['button'],
      submit: ['button'],
      reset: ['button'],
      checkbox: ['checkbox'],
      radio: ['radio'],
      search: ['searchbox'],
      email: ['textbox'],
      tel: ['textbox'],
      url: ['textbox'],
      text: ['textbox'],
    };
    const roles = inputTypeRoles[inputType] || ['textbox'];
    if (roles.includes(normalizedRole)) {
      return true;
    }
  }

  // Check implicit roles for other elements
  const roles = implicitRoles[tag] || [];
  return roles.includes(normalizedRole);
}

/**
 * Runs a DOM query operation based on mode (selector, role, label, text, or hybrid).
 * Returns an array of matching elements with their metadata.
 *
 * @param {Page} page - Playwright page instance
 * @param {Object} payload - Query payload with mode, query, and options
 * @returns {Promise<Array>} Array of FindResult objects
 */
async function runDomQuery(page, payload) {
  const mode = String(payload.mode || '').toLowerCase();
  const query = String(payload.query || '');
  const waitFor = Boolean(payload.waitFor !== false);
  const state = normalizeSelectorWaitState(payload.state);
  const all = Boolean(payload.all);

  if (!query && mode !== 'hybrid') {
    throw new Error('runDomQuery requires non-empty query string.');
  }

  // For selector mode with waitFor enabled, use Playwright's built-in wait
  if (mode === 'selector' && waitFor) {
    try {
      await page.waitForSelector(query, {
        state,
        timeout: normalizeTimeoutMs(payload.timeoutMs),
      });
    } catch (error) {
      // Selector not found - return empty array
      return [];
    }
  }

  // Execute the query in the browser context (with retry for context destruction)
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await page.evaluate(
    ({ mode, query, all, options, cellSize }) => {
      // Import helper functions into browser context
      const querySelectorAllDeep = (selector) => {
        const results = [];
        const visited = new WeakSet();

        const traverse = (root) => {
          if (!root) return;
          if (visited.has(root)) return;
          visited.add(root);

          try {
            const matches = root.querySelectorAll(selector);
            matches.forEach((el) => results.push(el));
          } catch (err) {
            // Invalid selector or DOM access error
          }

          try {
            const allElements = root.querySelectorAll('*');
            allElements.forEach((el) => {
              if (el.shadowRoot) {
                try {
                  traverse(el.shadowRoot);
                } catch (err) {
                  // Closed shadow root
                }
              }
            });
          } catch (err) {
            // Failed to query elements
          }
        };

        traverse(document);
        return results;
      };

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
        return raw.slice(0, 200);
      };

      const getAccessibleName = (el) => {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const referencedEl = document.getElementById(labelledBy.trim());
          if (referencedEl) return (referencedEl.innerText || referencedEl.textContent || '').trim();
        }

        if (el.id) {
          const label = document.querySelector(`label[for="${el.id}"]`);
          if (label) return (label.innerText || label.textContent || '').trim();
        }

        const parentLabel = el.closest('label');
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true);
          const nestedInputs = clone.querySelectorAll('input, select, textarea');
          nestedInputs.forEach((input) => input.remove());
          return (clone.innerText || clone.textContent || '').trim();
        }

        const placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return placeholder.trim();

        const title = el.getAttribute('title');
        if (title && title.trim()) return title.trim();

        return (el.innerText || el.textContent || '').trim();
      };

      const matchesRole = (el, role) => {
        const normalizedRole = String(role || '').toLowerCase().trim();
        if (!normalizedRole) return false;

        const explicitRole = el.getAttribute('role');
        if (explicitRole && explicitRole.toLowerCase() === normalizedRole) return true;

        const tag = el.tagName.toLowerCase();
        const implicitRoles = {
          button: ['button'],
          a: ['link'],
          input: ['textbox', 'checkbox', 'radio', 'button', 'searchbox'],
          select: ['combobox', 'listbox'],
          textarea: ['textbox'],
          img: ['img', 'image'],
          nav: ['navigation'],
          main: ['main'],
          header: ['banner'],
          footer: ['contentinfo'],
          aside: ['complementary'],
          section: ['region'],
          article: ['article'],
          form: ['form'],
          table: ['table'],
          ul: ['list'],
          ol: ['list'],
          li: ['listitem'],
          h1: ['heading'], h2: ['heading'], h3: ['heading'],
          h4: ['heading'], h5: ['heading'], h6: ['heading'],
          dialog: ['dialog'],
          summary: ['button'],
        };

        if (tag === 'input') {
          const inputType = (el.getAttribute('type') || 'text').toLowerCase();
          const inputTypeRoles = {
            button: ['button'], submit: ['button'], reset: ['button'],
            checkbox: ['checkbox'], radio: ['radio'], search: ['searchbox'],
            email: ['textbox'], tel: ['textbox'], url: ['textbox'], text: ['textbox'],
          };
          const roles = inputTypeRoles[inputType] || ['textbox'];
          if (roles.includes(normalizedRole)) return true;
        }

        const roles = implicitRoles[tag] || [];
        return roles.includes(normalizedRole);
      };

      const buildSelector = (el) => {
        const findAnchor = (element) => {
          let node = element;
          while (node) {
            if (node.id) return node;
            node = node.parentElement;
          }
          return document.body || document.documentElement;
        };

        const segmentForNode = (node) => {
          if (node.id) return `#${node.id}`;
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) return tag;

          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length === 1) return tag;

          const index = siblings.indexOf(node);
          return `${tag}:nth-of-type(${index + 1})`;
        };

        const anchor = findAnchor(el);
        const segments = [];
        let node = el;
        while (node && node !== anchor) {
          segments.unshift(segmentForNode(node));
          node = node.parentElement;
        }

        const anchorSeg = anchor.id ? `#${anchor.id}` : anchor.tagName.toLowerCase();
        segments.unshift(anchorSeg);
        return segments.join(' > ');
      };

      // DPR/zoom computation for converting CSS rects to image-pixel space
      const rawDpr = Number(window.devicePixelRatio) || 1;
      const dpr = Math.max(1.0, Math.min(4.0, rawDpr));
      const htmlZoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
      const bodyZoom = document.body ? (Number(getComputedStyle(document.body).zoom) || 1) : 1;
      const cssZoom = htmlZoom * bodyZoom;
      const safeCssZoom = (cssZoom > 0 && isFinite(cssZoom)) ? cssZoom : 1;
      const effectiveScale = dpr * safeCssZoom;

      const colLabelFromIndex = (index) => {
        let i = index;
        let label = '';
        while (i >= 0) {
          label = String.fromCharCode(65 + (i % 26)) + label;
          i = Math.floor(i / 26) - 1;
        }
        return label;
      };

      const buildFindResult = (el) => {
        const rect = el.getBoundingClientRect();
        let boundingBox = undefined;
        let gridRange = undefined;

        if (rect && rect.width > 0 && rect.height > 0) {
          // Use page-level coordinates (add scroll offset) so gridRange is
          // stable regardless of scroll position and matches fullPage captures.
          const pageLeft = rect.left + window.scrollX;
          const pageTop = rect.top + window.scrollY;
          const x = Math.round(pageLeft * effectiveScale);
          const y = Math.round(pageTop * effectiveScale);
          const w = Math.round(rect.width * effectiveScale);
          const h = Math.round(rect.height * effectiveScale);
          boundingBox = { x, y, width: w, height: h };

          const startCol = Math.floor(x / cellSize);
          const startRow = Math.floor(y / cellSize);
          const endCol = Math.floor(Math.max(0, x + w - 1) / cellSize);
          const endRow = Math.floor(Math.max(0, y + h - 1) / cellSize);
          gridRange = {
            start: colLabelFromIndex(startCol) + String(startRow + 1),
            end: colLabelFromIndex(endCol) + String(endRow + 1),
          };
        }

        return {
          selector: buildSelector(el),
          tag: el.tagName,
          text: getText(el),
          href: el.tagName === 'A' ? el.href || undefined : undefined,
          placeholder: el.placeholder || undefined,
          type: el.type || undefined,
          role: el.getAttribute('role') || undefined,
          label: el.getAttribute('aria-label') || undefined,
          boundingBox,
          gridRange,
        };
      };

      // Main query logic based on mode
      let candidates = [];

      if (mode === 'selector') {
        // Direct CSS selector query
        try {
          candidates = Array.from(querySelectorAllDeep(query));
        } catch (error) {
          return [];
        }
      } else if (mode === 'role') {
        // Query by ARIA role
        // Get all elements from the document
        const allElements = [];
        const visited = new WeakSet();

        const collectElements = (root) => {
          if (!root) return;
          if (visited.has(root)) return;
          visited.add(root);

          try {
            const elements = root.querySelectorAll('*');
            elements.forEach((el) => {
              allElements.push(el);
              if (el.shadowRoot) {
                try {
                  collectElements(el.shadowRoot);
                } catch (err) {
                  // Closed shadow root
                }
              }
            });
          } catch (err) {
            // Failed to query elements
          }
        };

        collectElements(document);

        // Filter by role
        candidates = allElements.filter((el) => matchesRole(el, query));

        // Apply additional filters from options
        if (options) {
          if (options.name) {
            const isRegex = options.name instanceof RegExp || (typeof options.name === 'string' && options.name.startsWith('/'));

            candidates = candidates.filter((el) => {
              const accessibleName = getAccessibleName(el);

              if (isRegex) {
                let pattern = options.name;
                if (typeof pattern === 'string' && pattern.startsWith('/')) {
                  const lastSlash = pattern.lastIndexOf('/');
                  const flags = lastSlash > 0 ? pattern.slice(lastSlash + 1) : '';
                  pattern = pattern.slice(1, lastSlash > 0 ? lastSlash : undefined);
                  const regex = new RegExp(pattern, flags);
                  return regex.test(accessibleName);
                }
                return options.name.test(accessibleName);
              } else {
                const targetName = String(options.name);
                let elName = accessibleName;
                let targetNameCompare = targetName;

                const caseSensitive = Boolean(options.caseSensitive);
                const exact = Boolean(options.exact);

                if (!caseSensitive) {
                  elName = elName.toLowerCase();
                  targetNameCompare = targetNameCompare.toLowerCase();
                }

                if (exact) {
                  return elName === targetNameCompare;
                } else {
                  return elName.includes(targetNameCompare);
                }
              }
            });
          }

          if (options.state) {
            const targetState = String(options.state).toLowerCase();
            candidates = candidates.filter((el) => {
              if (targetState === 'checked') {
                return el.checked === true || el.getAttribute('aria-checked') === 'true';
              }
              if (targetState === 'unchecked') {
                return el.checked === false || el.getAttribute('aria-checked') === 'false';
              }
              if (targetState === 'disabled') {
                return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
              }
              if (targetState === 'enabled') {
                return el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
              }
              return true;
            });
          }
        }
      } else if (mode === 'label') {
        // Query by accessible label
        // Get all elements from the document
        const allElements = [];
        const visited = new WeakSet();

        const collectElements = (root) => {
          if (!root) return;
          if (visited.has(root)) return;
          visited.add(root);

          try {
            const elements = root.querySelectorAll('*');
            elements.forEach((el) => {
              allElements.push(el);
              if (el.shadowRoot) {
                try {
                  collectElements(el.shadowRoot);
                } catch (err) {
                  // Closed shadow root
                }
              }
            });
          } catch (err) {
            // Failed to query elements
          }
        };

        collectElements(document);

        // Filter by accessible name
        const caseSensitive = options && Boolean(options.caseSensitive);
        const exact = options && Boolean(options.exact);
        const isRegex = options && Boolean(options.isRegex);

        candidates = allElements.filter((el) => {
          const accessibleName = getAccessibleName(el);

          if (isRegex) {
            try {
              const regex = new RegExp(query, caseSensitive ? '' : 'i');
              return regex.test(accessibleName);
            } catch (err) {
              return false;
            }
          } else {
            let elLabel = accessibleName;
            let targetLabel = query;

            if (!caseSensitive) {
              elLabel = elLabel.toLowerCase();
              targetLabel = targetLabel.toLowerCase();
            }

            if (exact) {
              return elLabel === targetLabel;
            } else {
              return elLabel.includes(targetLabel);
            }
          }
        });
      } else if (mode === 'text') {
        // Query by text content
        // Get all elements from the document
        const allElements = [];
        const visited = new WeakSet();

        const collectElements = (root) => {
          if (!root) return;
          if (visited.has(root)) return;
          visited.add(root);

          try {
            const elements = root.querySelectorAll('*');
            elements.forEach((el) => {
              allElements.push(el);
              if (el.shadowRoot) {
                try {
                  collectElements(el.shadowRoot);
                } catch (err) {
                  // Closed shadow root
                }
              }
            });
          } catch (err) {
            // Failed to query elements
          }
        };

        collectElements(document);

        // Apply tag filter if specified
        if (options && options.tag) {
          const targetTag = String(options.tag).toUpperCase();
          allElements.splice(0, allElements.length, ...allElements.filter((el) => el.tagName === targetTag));
        }

        // Filter by text content
        const caseSensitive = options && Boolean(options.caseSensitive);
        const exact = options && Boolean(options.exact);
        const isRegex = options && Boolean(options.isRegex);

        candidates = allElements.filter((el) => {
          const text = getText(el);

          if (isRegex) {
            try {
              const regex = new RegExp(query, caseSensitive ? '' : 'i');
              return regex.test(text);
            } catch (err) {
              return false;
            }
          } else {
            let elText = text;
            let targetText = query;

            if (!caseSensitive) {
              elText = elText.toLowerCase();
              targetText = targetText.toLowerCase();
            }

            if (exact) {
              return elText === targetText;
            } else {
              return elText.includes(targetText);
            }
          }
        });
      } else if (mode === 'hybrid') {
        // Vision-assisted query (not implemented in this P0 - would be P2)
        return [];
      } else {
        throw new Error(`Unknown domQuery mode: ${mode}`);
      }

      // Filter to visible, interactive elements for non-selector modes
      if (mode !== 'selector') {
        candidates = candidates.filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (!isInteractive(el)) return false;
          const rect = el.getBoundingClientRect();
          return rect && rect.width > 0 && rect.height > 0;
        });
      }

      // Build result objects
      const results = candidates.map(buildFindResult);

      // Return all or first match
      if (all) {
        return results;
      }
      return results.length > 0 ? [results[0]] : [];
    },
    { mode, query, all, options: payload.options, cellSize: CELL_SIZE }
  );

      return result || [];
    } catch (error) {
      if (!isRecoverableScanError(error) || attempt >= maxAttempts) throw error;
      lastError = error;
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

/**
 * Coordinate-based click fallback.
 *
 * boundingBox is in image-pixel space (DPR-scaled, page-level with scroll offsets baked in).
 * We need to convert to CSS viewport coordinates for page.mouse.click().
 *
 * Conversion:
 *   effectiveScale = dpr * cssZoom
 *   viewportX = (bb.x + bb.width / 2) / effectiveScale - scrollX
 *   viewportY = (bb.y + bb.height / 2) / effectiveScale - scrollY
 *
 * After computing coordinates, we validate with document.elementFromPoint() —
 * walking up 5 ancestors checking tag/text to confirm the right element is at that point.
 *
 * Returns { x, y } on success or throws on validation failure.
 */
async function coordinateFallbackClick(page, element) {
  const bb = element.boundingBox;
  if (!bb || bb.width === 0 || bb.height === 0) {
    throw new Error('coordinateFallback: boundingBox is empty or missing');
  }

  // Get DPR and CSS zoom — must match the computation used when building boundingBox
  const effectiveScale = await page.evaluate(() => {
    const rawDpr = Number(window.devicePixelRatio) || 1;
    const dpr = Math.max(1.0, Math.min(4.0, rawDpr));
    const htmlZoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const bodyZoom = document.body ? (Number(getComputedStyle(document.body).zoom) || 1) : 1;
    const cssZoom = htmlZoom * bodyZoom;
    const safeCssZoom = (cssZoom > 0 && isFinite(cssZoom)) ? cssZoom : 1;
    return dpr * safeCssZoom;
  });

  // Get current scroll offsets
  const scroll = await page.evaluate(() => ({
    x: window.scrollX || window.pageXOffset || 0,
    y: window.scrollY || window.pageYOffset || 0,
  }));

  const viewportX = (bb.x + bb.width / 2) / effectiveScale - scroll.x;
  const viewportY = (bb.y + bb.height / 2) / effectiveScale - scroll.y;

  // Validate with elementFromPoint — walk up 5 ancestors checking tag/text match
  const valid = await page.evaluate(
    ({ x, y, expectedTag, expectedText }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;

      let current = el;
      for (let i = 0; i < 5; i++) {
        if (!current) break;
        const tag = current.tagName || '';
        const text = (current.innerText || current.textContent || '').trim().slice(0, 60);
        // Match if tag matches or text content has overlap
        if (expectedTag && tag.toLowerCase() === expectedTag.toLowerCase()) return true;
        if (expectedText && text.length > 0 && text.includes(expectedText.slice(0, 30))) return true;
        current = current.parentElement;
      }
      return false;
    },
    { x: viewportX, y: viewportY, expectedTag: element.tag || '', expectedText: element.text || '' }
  );

  if (!valid) {
    throw new Error('coordinateFallback: elementFromPoint validation failed — wrong element at computed coordinates');
  }

  await page.mouse.click(viewportX, viewportY);
  return { x: viewportX, y: viewportY };
}

/**
 * Runs a verification check against the page.
 *
 * Handles 7 verification types:
 *   urlContains, urlMatches, textAppears, selectorGone,
 *   selectorAppears, ariaState, custom
 *
 * Returns { passed: boolean, message: string, durationMs: number }.
 */
async function runVerify(page, payload) {
  const startTs = Date.now();
  const check = payload.check || payload;
  const type = check.type;
  const timeoutMs = normalizeTimeoutMs(check.timeoutMs);

  try {
    if (type === 'urlContains') {
      const value = String(check.value || '');
      await page.waitForURL((url) => String(url).includes(value), { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return { passed: true, message: `URL contains "${value}"`, durationMs: Date.now() - startTs };
    }

    if (type === 'urlMatches') {
      const pattern = new RegExp(String(check.pattern || ''));
      await page.waitForURL(pattern, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return { passed: true, message: `URL matches ${pattern}`, durationMs: Date.now() - startTs };
    }

    if (type === 'textAppears') {
      const text = String(check.text || '');
      const within = check.within ? String(check.within) : 'body';
      await page.waitForFunction(
        ({ text, within }) => {
          const container = document.querySelector(within);
          if (!container) return false;
          return (container.innerText || container.textContent || '').includes(text);
        },
        { text, within },
        { timeout: timeoutMs }
      );
      return { passed: true, message: `Text "${text}" appeared`, durationMs: Date.now() - startTs };
    }

    if (type === 'selectorGone') {
      const selector = String(check.selector || '');
      await page.waitForSelector(selector, { state: 'detached', timeout: timeoutMs });
      return { passed: true, message: `Selector "${selector}" is gone`, durationMs: Date.now() - startTs };
    }

    if (type === 'selectorAppears') {
      const selector = String(check.selector || '');
      const state = normalizeSelectorWaitState(check.state) || 'visible';
      await page.waitForSelector(selector, { state, timeout: timeoutMs });
      return { passed: true, message: `Selector "${selector}" appeared (${state})`, durationMs: Date.now() - startTs };
    }

    if (type === 'ariaState') {
      const selector = String(check.selector || '');
      const expected = check.expected || {};
      await page.waitForFunction(
        ({ selector, expected }) => {
          const el = document.querySelector(selector);
          if (!el) return false;
          for (const [attr, value] of Object.entries(expected)) {
            const actual = el.getAttribute(`aria-${attr}`) || el.getAttribute(attr);
            if (actual !== value) return false;
          }
          return true;
        },
        { selector, expected },
        { timeout: timeoutMs }
      );
      return { passed: true, message: `ARIA state matches on "${selector}"`, durationMs: Date.now() - startTs };
    }

    if (type === 'custom') {
      const evaluator = String(check.evaluator || '');
      if (!evaluator) throw new Error('verify custom requires evaluator.');
      await page.waitForFunction(evaluator, { timeout: timeoutMs });
      return { passed: true, message: 'Custom verification passed', durationMs: Date.now() - startTs };
    }

    throw new Error(`Unknown verify type: ${String(type)}`);
  } catch (err) {
    return { passed: false, message: String(err && err.message ? err.message : err), durationMs: Date.now() - startTs };
  }
}

async function runDomQueryFirst(page, findPayload) {
  const elements = await runDomQuery(page, { ...findPayload, all: false });
  return (elements && elements.length > 0) ? elements[0] : null;
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
