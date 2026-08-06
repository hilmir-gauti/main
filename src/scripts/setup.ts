/**
 * First-run setup: creates the single operator account.
 *
 * Reads the credentials from OPERATOR_EMAIL / OPERATOR_PASSWORD when present,
 * otherwise prompts. The password is never echoed and never stored in plain
 * text — only its scrypt hash reaches the database.
 *
 *   npm run setup
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';

import { config } from '../config.ts';
import { closeDatabase, openDatabase } from '../core/db.ts';
import { logger } from '../core/logger.ts';
import { createOperator, operatorCount } from '../domain/auth.ts';

/** Reads a line without echoing it back to the terminal. */
async function askSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // Suppress echo by intercepting the output stream while the answer is typed.
  const originalWrite = stdout.write.bind(stdout);
  let muted = false;
  (stdout as unknown as { write: typeof originalWrite }).write = ((chunk: string, ...rest: unknown[]) => {
    if (muted) return true;
    return originalWrite(chunk, ...(rest as []));
  }) as typeof originalWrite;

  originalWrite(prompt);
  muted = true;
  const answer = await rl.question('');
  muted = false;
  originalWrite('\n');

  (stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  rl.close();
  return answer;
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

async function run(): Promise<void> {
  openDatabase();

  if (operatorCount() > 0) {
    console.log('\nStjórnandi er þegar til. Ekkert gert.\n');
    console.log(`Skráðu þig inn á ${config.baseUrl}/innskraning\n`);
    closeDatabase();
    return;
  }

  console.log('\n=== Rafræn Þjónusta — uppsetning ===\n');

  if (!config.appSecret) {
    const suggestion = randomBytes(32).toString('hex');
    console.log('APP_SECRET er ekki stillt. Bættu þessari línu í .env áður en farið er í rekstur:\n');
    console.log(`  APP_SECRET=${suggestion}\n`);
    console.log('Án hennar tapast innskráningar og geymdir aðgangslyklar við endurræsingu.\n');
  }

  // When both credentials come from the environment the run is scripted
  // (Docker entrypoint, CI, provisioning script), so nothing may block on a
  // prompt — stdin is typically closed and the process would hang forever.
  const nonInteractive = Boolean(config.operator.email && config.operator.initialPassword) || !stdin.isTTY;

  const email = config.operator.email || (nonInteractive ? '' : await ask('Netfang stjórnanda: '));
  let password = config.operator.initialPassword;

  if (!password && !nonInteractive) {
    password = await askSecret('Lykilorð (minnst 12 stafir): ');
    const again = await askSecret('Endurtaktu lykilorðið: ');
    if (password !== again) {
      console.error('\nLykilorðin stemma ekki. Hættu við.\n');
      closeDatabase();
      process.exit(1);
    }
  }

  if (!email || !password) {
    console.error('\nNetfang og lykilorð vantar.');
    console.error('Keyrðu í flugstöð, eða settu OPERATOR_EMAIL og OPERATOR_PASSWORD í umhverfið.\n');
    closeDatabase();
    process.exit(1);
  }

  const name = nonInteractive ? '' : await ask('Nafn (valfrjálst): ');

  try {
    const operator = await createOperator(email, password, name);
    console.log(`\nStjórnandi stofnaður: ${operator.email}`);
    console.log(`Skráðu þig inn á ${config.baseUrl}/innskraning\n`);
  } catch (error) {
    console.error(`\nUppsetning mistókst: ${error instanceof Error ? error.message : String(error)}\n`);
    closeDatabase();
    process.exit(1);
  }

  closeDatabase();
}

run().catch((error) => {
  logger.error('Uppsetning mistókst', { error });
  process.exit(1);
});
