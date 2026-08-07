/**
 * Build identification.
 *
 * A packaged executable is a frozen copy of the source, so "am I running the
 * version I just built?" is a question that comes up constantly and is
 * otherwise unanswerable. These values are baked in at build time and shown in
 * the console banner and on the system settings page.
 *
 * In development the identifiers do not exist, and `typeof` on an undeclared
 * name is safe in JavaScript, so the guards below resolve to the dev fallback
 * without throwing.
 */

declare const __RTH_BUILD_TIME__: string;
declare const __RTH_COMMIT__: string;

function baked(read: () => string): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

const buildTime = baked(() => (typeof __RTH_BUILD_TIME__ === 'string' ? __RTH_BUILD_TIME__ : ''));
const commit = baked(() => (typeof __RTH_COMMIT__ === 'string' ? __RTH_COMMIT__ : ''));

export const buildInfo = {
  /** ISO timestamp of the build, empty when running from source. */
  time: buildTime,
  /** Short git commit the build came from, empty when unavailable. */
  commit,
  /** True when running as a packaged executable. */
  packaged: buildTime !== '',
} as const;

/** One-line description for the console banner and settings page. */
export function buildLabel(): string {
  if (!buildInfo.packaged) return 'þróunarútgáfa (keyrt úr kóða)';

  const stamp = buildInfo.time.slice(0, 16).replace('T', ' ');
  return buildInfo.commit ? `smíðuð ${stamp} · ${buildInfo.commit}` : `smíðuð ${stamp}`;
}
