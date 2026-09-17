/**
 * Load .env before any module reads process.env.
 *
 * Production uses docker-compose env_file, so a container without .env is normal.
 * Local development (npm run dev / check / probe) depends on this loader.
 *
 * Use Node's built-in loadEnvFile instead of adding dotenv. Node >= 22.5 is
 * already required for node:sqlite. Real environment variables override .env,
 * so `FOO=x npm run dev` can temporarily override a setting.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
if (existsSync(path)) {
  const before = { ...process.env };
  process.loadEnvFile(path);
  // loadEnvFile overwrites existing variables; restore the real environment.
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}
