/**
 * Rafræn Þjónusta — entry point.
 *
 * Boots the database, wires the routers, registers event subscribers, starts
 * the background worker and the HTTP server, and shuts all of it down cleanly.
 */

import { config, validateConfig } from './config.ts';
import { openDatabase, closeDatabase, schemaVersion } from './core/db.ts';
import { logger } from './core/logger.ts';
import { operatorCount } from './domain/auth.ts';
import { applySettings } from './domain/settings.ts';
import { registerSubscribers } from './integrations/subscribers.ts';
import { voiceRouter } from './integrations/voice/routes.ts';
import { adminRouter } from './admin/routes.ts';
import { mobileRouter } from './mobileapi/routes.ts';
import { publicRouter } from './publicapi/routes.ts';
import { contentSecurityPolicy } from './http/middleware.ts';
import { json } from './http/response.ts';
import { Router } from './http/router.ts';
import { createHttpServer, startServer, stopServer } from './http/server.ts';
import { startWorker, stopWorker } from './worker.ts';

function buildRouter(): Router {
  const router = new Router();
  router.use(contentSecurityPolicy);

  /** Liveness probe — no auth, no database write. */
  router.get('/heilsa', () =>
    json({
      stada: 'i_lagi',
      utgafa: schemaVersion(),
      umhverfi: config.env,
      timi: new Date().toISOString(),
    }),
  );

  // Order matters only where paths could overlap; these prefixes are disjoint.
  router.mount('', publicRouter());
  router.mount('', mobileRouter());
  router.mount('', voiceRouter());
  router.mount('', adminRouter());

  return router;
}

export async function main(): Promise<void> {
  const problems = validateConfig();
  if (problems.length > 0) {
    for (const problem of problems) logger.error(`Stillingavilla: ${problem}`);
    if (config.isProduction) {
      logger.error('Stöðva ræsingu vegna stillingavillna.');
      process.exit(1);
    }
    logger.warn('Held áfram þrátt fyrir stillingavillur (þróunarumhverfi).');
  }

  openDatabase();
  logger.info('Gagnagrunnur opnaður', { path: config.databasePath, schema: schemaVersion() });

  // Credentials entered in the console live in the database, so they can only
  // be applied once it is open. They override the environment from here on.
  applySettings();

  if (operatorCount() === 0 && process.env.RTH_EMBEDDED !== '1') {
    // The desktop build points the browser at /uppsetning instead, so this
    // terminal-specific advice would be misleading there.
    logger.warn('Enginn stjórnandi er skráður. Keyrðu `npm run setup` til að stofna aðgang.');
  }

  registerSubscribers();

  const server = createHttpServer(buildRouter());
  await startServer(server);
  startWorker();

  logger.info('Rafræn Þjónusta er tilbúin', {
    stjornbord: `${config.baseUrl}/stjornbord`,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Stöðva þjónustu', { signal });

    stopWorker();
    await stopServer(server);
    closeDatabase();

    logger.info('Stöðvun lokið');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Ómeðhöndluð höfnun', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Ómeðhöndluð undantekning', { error });
    void shutdown('uncaughtException');
  });
}

/**
 * Auto-start only when this module is the process entry point.
 *
 * `RTH_EMBEDDED` is set by the desktop launcher, which drives the lifecycle
 * itself, and the check is skipped entirely under the test runner so importing
 * this module never binds a port.
 */
const isEntryPoint =
  process.env.RTH_EMBEDDED !== '1' &&
  Boolean(process.argv[1]) &&
  /(?:^|[\\/])index\.(?:js|ts)$/.test(process.argv[1]!);

if (isEntryPoint) {
  void main().catch((error) => {
    logger.error('Ræsing mistókst', { error });
    process.exit(1);
  });
}

export { buildRouter };
