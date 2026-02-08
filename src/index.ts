import { getAuthConfig, type Env } from './auth';
import { createChromeBrowserClient } from './chrome-client';

export type { Env } from './auth';
export type {
  Action,
  ElementInfo,
  ExecutableStatus,
  GridRange,
  LaunchOptions,
  LaunchResult,
  TabInfo,
  Zone,
  ZoneResult,
} from './chrome-client';

export default function main(env: Env = {}) {
  const config = getAuthConfig(env);
  return createChromeBrowserClient(config);
}
