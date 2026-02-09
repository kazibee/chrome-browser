import { getAuthConfig, type Env } from './auth';
import { createChromeBrowserClient } from './chrome-client';

export type { Env } from './auth';
export type {
  Action,
  ElementInfo,
  ExecutableStatus,
  FindInteractiveElementOptions,
  GridRange,
  LabelsOverviewOptions,
  ZoneLabelsOptions,
  ZoneLabelsResult,
  WaitStrategyOptions,
  ScanZonesOptions,
  GridCoordinateSpace,
  NavigationWaitOptions,
  PageLoadState,
  LabelsOptions,
  LaunchOptions,
  LaunchResult,
  SelectorWaitState,
  UiInteractiveElement,
  UiLabelsResult,
  UiLayoutRegion,
  UiOverviewRegion,
  UiOverviewResult,
  UiPointOfInterest,
  TabInfo,
  Zone,
  ZoneResult,
} from './chrome-client';

export default function main(env: Env = {}) {
  const config = getAuthConfig(env);
  return createChromeBrowserClient(config);
}
