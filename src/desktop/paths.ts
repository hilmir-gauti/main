/**
 * Desktop file locations and first-run configuration.
 *
 * When Rafræn Þjónusta runs as a packaged executable there is no `.env` file
 * and no terminal to run setup scripts in. Everything the server needs is
 * resolved here instead: a per-user data directory, a generated APP_SECRET
 * that survives restarts, and a chosen port.
 *
 * This module must not import `config.ts` — it runs *before* it, and sets the
 * environment variables that module reads at import time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface DesktopSettings {
  /** Generated once and reused, so sessions and stored tokens survive restarts. */
  appSecret: string;
  port: number;
  /** Open the browser automatically on start. */
  openBrowser: boolean;
  /** Written by the app so the user can see what to edit. */
  notes: string;
}

/**
 * Per-user application data directory, following each platform's convention:
 *
 *   Windows  %APPDATA%\RafraenThjonusta
 *   macOS    ~/Library/Application Support/RafraenThjonusta
 *   Linux    ~/.local/share/rafraen-thjonusta  (or $XDG_DATA_HOME)
 *
 * Deliberately *not* next to the executable: on Windows that is often
 * Program Files, which a normal user account cannot write to.
 */
export function dataDirectory(): string {
  const override = process.env.RTH_DATA_DIR || process.env.DATA_DIR;
  if (override) return override;

  const os = platform();
  if (os === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'RafraenThjonusta');
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'RafraenThjonusta');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'rafraen-thjonusta');
}

const DEFAULTS: Omit<DesktopSettings, 'appSecret'> = {
  port: 8080,
  openBrowser: true,
  notes: 'Þessi skrá geymir stillingar forritsins. Ekki eyða appSecret — þá tapast innskráningar og geymdir aðgangslyklar.',
};

/**
 * Loads settings, creating them on first run. The generated secret is written
 * with restrictive permissions where the platform supports it.
 */
export function loadSettings(directory: string): DesktopSettings {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'stillingar.json');

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopSettings>;
      if (typeof parsed.appSecret === 'string' && parsed.appSecret.length >= 32) {
        return {
          appSecret: parsed.appSecret,
          port: Number(parsed.port) || DEFAULTS.port,
          openBrowser: parsed.openBrowser !== false,
          notes: DEFAULTS.notes,
        };
      }
    } catch {
      // Corrupt settings file: fall through and write a fresh one rather than
      // refusing to start. The secret is regenerated, which logs the user out
      // but never loses booking data.
    }
  }

  const settings: DesktopSettings = { ...DEFAULTS, appSecret: randomBytes(32).toString('hex') };
  writeFileSync(path, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  return settings;
}

export function settingsPath(directory: string): string {
  return join(directory, 'stillingar.json');
}
