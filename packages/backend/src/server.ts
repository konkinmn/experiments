import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
