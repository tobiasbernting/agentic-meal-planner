import type { Logger } from "../../logging/logger.js";
import type { SchoolPlugin } from "../../types.js";
import { exampleJsonPlugin, type FetchPage } from "./example-json.js";

export type { FetchPage } from "./example-json.js";

/**
 * The School Plugin registry (ADR-0004). Add your plugin to this array; the first one whose
 * `claims(url)` is true wins, so put specific formats before generic ones. Plugins receive
 * the app's page fetcher so they stay network-free in tests.
 */
export function createSchoolPlugins(fetchPage: FetchPage, log?: Logger): SchoolPlugin[] {
  return [exampleJsonPlugin(fetchPage, log)];
}

/** The first plugin claiming `url`, or undefined when the LLM fallback should be used. */
export function findPlugin(url: string, plugins: SchoolPlugin[]): SchoolPlugin | undefined {
  return plugins.find((plugin) => plugin.claims(url));
}
