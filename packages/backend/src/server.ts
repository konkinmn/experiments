import { config } from 'dotenv';
import { existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep the process alive on async faults (Node 23 crashes on unhandledRejection by default,
// which would kill an in-flight queue run and orphan it). Log to console + a file for triage.
const crashLog = resolve(__dirname, '../crash.log');
function logFatal(kind: string, err: unknown) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const line = `\n[${new Date().toISOString()}] ${kind}\n${detail}\n`;
  console.error(line);
  try {
    appendFileSync(crashLog, line);
  } catch {
    /* best effort */
  }
}
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));

const envPaths = [
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../../.env'),
];

const envPath = envPaths.find((path) => existsSync(path));
if (envPath) {
  const result = config({ path: envPath });
  if (result.error) {
    console.warn('Failed to load .env file:', result.error.message);
  }
} else {
  console.warn(
    'No .env file found. Checked:',
    envPaths.join(', '),
  );
}

async function start() {
  // Dynamic import to ensure env vars are loaded first
  const { buildApp } = await import('./app.js');

  const PORT = parseInt(process.env.PORT || '3003', 10);
  const HOST = process.env.HOST || '0.0.0.0';

  const app = buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
