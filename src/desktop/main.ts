/**
 * Desktop entry point — what runs when someone double-clicks the executable.
 *
 * Responsibilities beyond the plain server: resolve a writable data directory,
 * generate and persist a secret, find a free port, print a console window the
 * user can actually read, and open their browser on the control panel.
 *
 * Everything the environment would normally supply through `.env` is set here
 * *before* `config.ts` is imported, since that module reads the environment
 * once at import time.
 */

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';

import { buildLabel } from '../version.ts';
import { dataDirectory, loadSettings, settingsPath } from './paths.ts';

// Node prints an ExperimentalWarning for the built-in SQLite module. That is
// useful to a developer and noise to someone who double-clicked an icon, so the
// default warning printer is replaced with a silent one. A packaged binary
// cannot pass --no-warnings to itself.
process.removeAllListeners('warning');
process.on('warning', () => {});

const BANNER = String.raw`
  ____        __
 |  _ \ __ _ / _|_ __ __ _  ___ _ __
 | |_) / _' | |_| '__/ _' |/ _ \ '_ \
 |  _ < (_| |  _| | | (_| |  __/ | | |
 |_| \_\__,_|_| |_|  \__,_|\___|_| |_|
        Þ J Ó N U S T A
`;

/** Finds the first free port at or after `start`. */
async function freePort(start: number, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`Fann engan lausan port á bilinu ${start}–${start + attempts}.`);
}

/** Opens the user's default browser, without failing the app if it cannot. */
function openBrowser(url: string): void {
  const os = platform();
  try {
    if (os === 'win32') {
      // `start` is a cmd builtin; the empty string is the (required) window title.
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (os === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Headless or restricted environment — the URL is printed either way.
  }
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export async function start(): Promise<void> {
  const directory = dataDirectory();
  const settings = loadSettings(directory);
  const port = await freePort(Number(process.env.PORT) || settings.port);
  const url = `http://localhost:${port}`;

  // Supply everything config.ts expects before it is loaded.
  process.env.NODE_ENV ??= 'production';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = join(directory, 'rafraen.sqlite');
  process.env.SITES_DIR = join(directory, 'vefsidur');
  process.env.APP_SECRET = settings.appSecret;
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.BASE_URL = url;
  process.env.LOG_LEVEL ??= 'warn';
  // Tells index.ts not to auto-start; this module drives the lifecycle.
  process.env.RTH_EMBEDDED = '1';

  line(BANNER);
  line('  Stjórnborð fyrir stafræna þjónustu við íslensk smáfyrirtæki');
  line(`  ${buildLabel()}`);
  line('  ─────────────────────────────────────────────────────────────');
  line();

  const { main } = await import('../index.ts');
  const { operatorCount } = await import('../domain/auth.ts');

  try {
    await main();
  } catch (error) {
    line('  ✖  Ræsing mistókst.');
    line();
    line(`     ${error instanceof Error ? error.message : String(error)}`);
    line();
    line('  Gluggi lokast eftir 30 sekúndur.');
    setTimeout(() => process.exit(1), 30_000);
    return;
  }

  const firstRun = operatorCount() === 0;
  const target = firstRun ? `${url}/uppsetning` : `${url}/stjornbord`;

  line(`  ✔  Forritið er í gangi`);
  line();
  line(`     Slóð          ${target}`);
  line(`     Gögn          ${directory}`);
  line(`     Stillingar    ${settingsPath(directory)}`);
  line();

  if (firstRun) {
    line('  ►  Fyrsta keyrsla — vafrinn opnast á uppsetningarsíðu þar sem þú');
    line('     býrð til aðganginn þinn.');
  } else {
    line('  ►  Vafrinn opnast á stjórnborðinu.');
  }

  line();
  line('  ─────────────────────────────────────────────────────────────');
  line('  Lokaðu þessum glugga til að stöðva forritið.');
  line();

  if (settings.openBrowser && process.env.RTH_NO_BROWSER !== '1') {
    // A short delay lets the server finish binding before the browser knocks.
    setTimeout(() => openBrowser(target), 600);
  }
}

// Executed directly by the packaged binary.
start().catch((error) => {
  line(`Óvænt villa: ${error instanceof Error ? error.stack : String(error)}`);
  setTimeout(() => process.exit(1), 30_000);
});
