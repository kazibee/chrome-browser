/**
 * Composable resilience types for atomic browser actions.
 *
 * Target — HOW to find the element (by: selector | role | label | text | point)
 * Verify — WHAT to assert after acting (urlContains | textAppears | selectorGone | ...)
 * Resilience — HOW to retry on failure (retries, coordinateFallback, timeoutMs, retryDelay)
 * ActionResult — WHAT happened (ok, attempts, durationMs, findResult, verification, error)
 *
 * Used by atomicClick, atomicType, atomicSelect, atomicSubmit.
 */

import type { BoundingBox, GridRange, NavigationWaitOptions, SelectorWaitState } from './chrome-client';

// ---------------------------------------------------------------------------
// Target — how to find the element (discriminated union on `by`)
// ---------------------------------------------------------------------------

export interface TargetBySelector {
  by: 'selector';
  selector: string;
  waitFor?: boolean;
  state?: SelectorWaitState;
}

export interface TargetByRole {
  by: 'role';
  role: string;
  name?: string | RegExp;
  ariaState?: Record<string, boolean>;
}

export interface TargetByLabel {
  by: 'label';
  labelText: string | RegExp;
  exact?: boolean;
  caseSensitive?: boolean;
}

export interface TargetByText {
  by: 'text';
  text: string | RegExp;
  tag?: string;
  exact?: boolean;
  caseSensitive?: boolean;
}

export interface TargetByPoint {
  by: 'point';
  x: number;
  y: number;
}

/** Which element to act on. Discriminated by the `by` field. */
export type Target =
  | TargetBySelector
  | TargetByRole
  | TargetByLabel
  | TargetByText
  | TargetByPoint;

// ---------------------------------------------------------------------------
// Verify — post-action assertion (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface VerifyUrlContains {
  type: 'urlContains';
  value: string;
  timeoutMs?: number;
}

export interface VerifyUrlMatches {
  type: 'urlMatches';
  pattern: string;
  timeoutMs?: number;
}

export interface VerifyTextAppears {
  type: 'textAppears';
  text: string;
  within?: string;
  timeoutMs?: number;
}

export interface VerifySelectorGone {
  type: 'selectorGone';
  selector: string;
  timeoutMs?: number;
}

export interface VerifySelectorAppears {
  type: 'selectorAppears';
  selector: string;
  state?: SelectorWaitState;
  timeoutMs?: number;
}

export interface VerifyAriaState {
  type: 'ariaState';
  selector: string;
  expected: Record<string, string>;
  timeoutMs?: number;
}

export interface VerifyCustom {
  type: 'custom';
  evaluator: string;
  timeoutMs?: number;
}

/** Post-action assertion. Discriminated by the `type` field. All variants support `timeoutMs`. */
export type Verify =
  | VerifyUrlContains
  | VerifyUrlMatches
  | VerifyTextAppears
  | VerifySelectorGone
  | VerifySelectorAppears
  | VerifyAriaState
  | VerifyCustom;

// ---------------------------------------------------------------------------
// Retry delay strategy (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface RetryDelayFixed {
  type: 'fixed';
  delayMs: number;
}

export interface RetryDelayLinear {
  type: 'linear';
  baseMs: number;
}

export interface RetryDelayExponential {
  type: 'exponential';
  baseMs: number;
  maxMs?: number;
}

export type RetryDelayStrategy =
  | RetryDelayFixed
  | RetryDelayLinear
  | RetryDelayExponential;

// ---------------------------------------------------------------------------
// Resilience — retry/fallback strategy
// ---------------------------------------------------------------------------

/** Retry and fallback strategy. All fields optional — defaults to 1 attempt, no fallback. */
export interface Resilience {
  retries?: number;
  coordinateFallback?: boolean;
  waitForStable?: boolean;
  stabilityWindowMs?: number;
  timeoutMs?: number;
  retryDelay?: RetryDelayStrategy;
}

// ---------------------------------------------------------------------------
// Error classification (4-tier)
// ---------------------------------------------------------------------------

export type ErrorTier = 'A' | 'B' | 'C' | 'D';

export type ErrorCode =
  // Tier A — Transient
  | 'CONTEXT_DESTROYED'
  | 'FRAME_DETACHED'
  | 'BROWSER_CLOSED'
  // Tier B — Stale
  | 'ELEMENT_DETACHED'
  | 'ELEMENT_NOT_ATTACHED'
  | 'STALE_ELEMENT_REFERENCE'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  // Tier C — Navigation
  | 'PAGE_NAVIGATED'
  | 'URL_CHANGED'
  | 'CROSS_ORIGIN_NAVIGATION'
  // Tier D — Permanent
  | 'TIMEOUT'
  | 'SELECTOR_INVALID'
  | 'ELEMENT_NOT_FOUND'
  | 'UNKNOWN';

export interface ActionError {
  tier: ErrorTier;
  code: ErrorCode;
  message: string;
  rawMessage: string;
  retryable: boolean;
  retryStrategy?: RetryDelayStrategy;
}

// ---------------------------------------------------------------------------
// ActionResult — structured return from atomic operations
// ---------------------------------------------------------------------------

export interface ActionFindResult {
  selector: string;
  tag: string;
  text: string;
  boundingBox?: BoundingBox;
  gridRange?: GridRange;
}

export interface VerificationResult {
  passed: boolean;
  message: string;
  durationMs: number;
}

/** Structured result from atomic operations. Check `ok` first, then `verification?.passed` if verify was specified. */
export interface ActionResult {
  ok: boolean;
  attempts: number;
  durationMs: number;
  findResult?: ActionFindResult;
  coordinatesUsed?: { x: number; y: number };
  verification?: VerificationResult;
  error?: ActionError;
}

// ---------------------------------------------------------------------------
// Atomic action options
// ---------------------------------------------------------------------------

export interface AtomicClickOptions {
  target: Target;
  verify?: Verify;
  resilience?: Resilience;
  waitForNavigation?: boolean | NavigationWaitOptions;
}

export interface AtomicTypeOptions {
  target: Target;
  text: string;
  clearFirst?: boolean;
  verify?: Verify;
  resilience?: Resilience;
}

export interface AtomicSelectOptions {
  target: Target;
  value: string;
  verify?: Verify;
  resilience?: Resilience;
}

export interface AtomicSubmitOptions {
  target: Target;
  verify?: Verify;
  resilience?: Resilience;
  waitForNavigation?: boolean | NavigationWaitOptions;
}
