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
import { setDefaultResultOrder } from 'node:dns';

// Default DNS resolution to IPv4 first to avoid unreachable IPv6 routes in
// dual-stack environments and Docker bridge networks without IPv6 egress.
try {
  setDefaultResultOrder('ipv4first');
} catch {
  // best effort across node environments
}

const path = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
if (existsSync(path)) {
  const before = { ...process.env };
  process.loadEnvFile(path);
  // loadEnvFile overwrites existing variables; restore the real environment.
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}
