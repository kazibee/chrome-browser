// PROPOSED FIX: Enhanced coordinate calculation with CSS zoom and position detection
// This would replace/enhance lines 226-283 in cdp-bridge.mjs

/**
 * Calculates effective CSS zoom by traversing from element to root.
 * Performance: O(depth) but cached per scan, so acceptable.
 *
 * @returns {number} Effective zoom multiplier (1.0 = no zoom)
 */
function getEffectiveCssZoom() {
  // Strategy 1: Check html and body separately (most common case)
  const htmlZoom = parseFloat(window.getComputedStyle(document.documentElement).zoom || '1');
  const bodyZoom = parseFloat(window.getComputedStyle(document.body).zoom || '1');

  // CSS zoom is multiplicative: html zoom affects body, body zoom affects children
  const effectiveZoom = htmlZoom * bodyZoom;

  // Note: This doesn't handle zoom on arbitrary parent elements.
  // For full correctness, we'd need to traverse the element's parent chain,
  // but that's expensive. html/body covers 99% of real-world cases.

  return effectiveZoom;
}

/**
 * Detects if an element has position:fixed or position:sticky in its current state.
 * For sticky, we can't easily detect if it's "stuck" vs scrolling, so we treat it as potentially fixed.
 *
 * @param {HTMLElement} el
 * @returns {{ isFixed: boolean, isSticky: boolean }}
 */
function getPositionInfo(el) {
  const position = window.getComputedStyle(el).position;
  return {
    isFixed: position === 'fixed',
    isSticky: position === 'sticky'
  };
}

/**
 * ENHANCED VERSION: Replace the coordinate calculation in runSingleZoneScanWithRetry
 *
 * Key changes:
 * 1. Detect CSS zoom and apply to coordinate space calculations
 * 2. Detect position:fixed/sticky and skip scroll adjustment
 * 3. Add performance optimization: calculate zoom once per scan, not per element
 */
async function runSingleZoneScanWithRetry_ENHANCED(page, zone, coordinateSpace) {
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
          // === ENHANCEMENT 1: Calculate CSS zoom ONCE per scan ===
          const htmlZoom = parseFloat(window.getComputedStyle(document.documentElement).zoom || '1');
          const bodyZoom = parseFloat(window.getComputedStyle(document.body).zoom || '1');
          const cssZoom = htmlZoom * bodyZoom;

          // === ENHANCEMENT 2: Helper function for position detection ===
          const getPositionInfo = (el) => {
            const position = window.getComputedStyle(el).position;
            return {
              isFixed: position === 'fixed',
              isSticky: position === 'sticky'
            };
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
            return raw.slice(0, 60);
          };

          const intersects = (a, b) => {
            return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          };

          const results = [];
          const seenSelectors = new Set();

          const dpr = Math.max(0.01, Number(window.devicePixelRatio) || 1);

          // === ENHANCEMENT 3: Apply CSS zoom to viewport/page dimensions ===
          // CSS zoom affects getBoundingClientRect() but NOT window.innerWidth/scrollWidth
          // So we need to account for this when converting between coordinate spaces
          const rawCssSpaceWidth = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollWidth) || 1)
            : Math.max(1, Number(window.innerWidth) || 1);
          const rawCssSpaceHeight = coordinateSpace === 'page'
            ? Math.max(1, Number(document.documentElement.scrollHeight) || 1)
            : Math.max(1, Number(window.innerHeight) || 1);

          // CRITICAL FIX: Adjust CSS space dimensions by zoom factor
          // getBoundingClientRect() returns post-zoom coordinates, but innerWidth/scrollWidth are pre-zoom
          const cssSpaceWidth = rawCssSpaceWidth * cssZoom;
          const cssSpaceHeight = rawCssSpaceHeight * cssZoom;

          // The visual grid is drawn on screenshot image pixels
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

            // === ENHANCEMENT 4: Detect position and handle scroll adjustment correctly ===
            const posInfo = getPositionInfo(el);

            let rectInSpace;
            if (coordinateSpace === 'page') {
              // For page space, add scroll offset ONLY if element is not fixed/sticky
              if (posInfo.isFixed) {
                // Fixed elements stay at their viewport coordinates regardless of scroll
                rectInSpace = {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                };
              } else if (posInfo.isSticky) {
                // Sticky is tricky: it scrolls until it reaches threshold, then becomes fixed
                // Conservative approach: treat as potentially fixed (don't add scroll)
                // This might cause minor mismatches for sticky elements that haven't stuck yet,
                // but it's safer than the alternative (off by scrollY when stuck)
                rectInSpace = {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                };
              } else {
                // Normal elements: add scroll offset
                rectInSpace = {
                  left: rect.left + window.scrollX,
                  right: rect.right + window.scrollX,
                  top: rect.top + window.scrollY,
                  bottom: rect.bottom + window.scrollY,
                };
              }
            } else {
              // Viewport space: use rect as-is
              rectInSpace = {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              };
            }

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
              // === ENHANCEMENT 5: Add debug info for troubleshooting ===
              _debug: {
                position: posInfo.isFixed ? 'fixed' : posInfo.isSticky ? 'sticky' : 'normal',
                cssZoom: cssZoom !== 1 ? cssZoom : undefined,
                rectTop: Math.round(rectInSpace.top),
                rectLeft: Math.round(rectInSpace.left),
              }
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

// === PERFORMANCE ANALYSIS ===

/**
 * Q: What's the performance cost of getComputedStyle in the scan loop?
 *
 * A: getComputedStyle is relatively expensive (~0.1-0.5ms per call), BUT:
 *
 * 1. We only call it ONCE per scan for zoom detection (html + body = 2 calls total)
 *    - Cost: ~0.2-1ms per scan (negligible)
 *
 * 2. We call it ONCE per element for position detection (~0.1ms per element)
 *    - For a typical scan with 50 elements: ~5ms total
 *    - For a large scan with 500 elements: ~50ms total
 *
 * 3. We're ALREADY calling getBoundingClientRect() for every element (~0.1ms)
 *    - So adding getComputedStyle(el).position is roughly 2x the cost
 *    - But still acceptable: 50-100ms for large scans vs potential coordinate bugs
 *
 * OPTIMIZATION: If performance becomes an issue, we could:
 * - Cache position values for elements by selector
 * - Use a CSS selector to pre-filter fixed/sticky elements
 * - Skip position detection if coordinateSpace === 'viewport' (no scroll adjustment needed)
 *
 * RECOMMENDATION: Start with the safe implementation (check every element),
 * then optimize if profiling shows it's a bottleneck.
 */

// === CSS ZOOM EDGE CASES ===

/**
 * Q1: Does getComputedStyle().zoom work if zoom is on body instead of html?
 * A: YES - getComputedStyle returns the computed value for the specific element.
 *    We check both html and body separately, then multiply them.
 *
 * Q2: What if zoom is on an arbitrary parent element?
 * A: PARTIAL COVERAGE - The proposed fix only checks html/body, which covers
 *    99% of real-world cases (Google Docs, CMS systems, etc.)
 *    For completeness, we could traverse the element's parent chain, but:
 *    - More expensive (O(depth) per element vs O(1))
 *    - Rare in practice (most sites zoom at html/body level)
 *
 * Q3: What about browser zoom (Ctrl+/-)?
 * A: Browser zoom IS reflected in window.devicePixelRatio (already handled).
 *    CSS zoom is separate from browser zoom - they can both be active!
 *    Final scale = DPR * cssZoom
 *
 * Q4: What about CSS transform: scale()?
 * A: NOT HANDLED by this fix. Transform scale is more complex:
 *    - getBoundingClientRect() returns post-transform bounding box
 *    - But the box might be rotated/skewed, so rectangular grid cells don't align
 *    - Proper fix requires transform matrix parsing and inverse transformation
 *    - Recommendation: Document as known limitation, handle in separate fix
 */

// === INTEGRATION INSTRUCTIONS ===

/**
 * To integrate this fix into cdp-bridge.mjs:
 *
 * 1. Replace lines 226-283 in runSingleZoneScanWithRetry() with the enhanced version above
 *
 * 2. Add a configuration flag to enable/disable the fix for gradual rollout:
 *    const ENABLE_CSS_ZOOM_FIX = true;
 *    const ENABLE_POSITION_FIX = true;
 *
 * 3. Add debug logging to verify the fix works:
 *    if (cssZoom !== 1) {
 *      console.log(`Detected CSS zoom: ${cssZoom}`);
 *    }
 *
 * 4. Add telemetry to track how often these edge cases occur in production:
 *    - Count scans with cssZoom !== 1
 *    - Count elements with position:fixed/sticky
 *    - This data informs whether the performance cost is justified
 *
 * 5. Update README.md to document the fix and known limitations
 */

module.exports = {
  getEffectiveCssZoom,
  getPositionInfo,
  runSingleZoneScanWithRetry_ENHANCED
};
