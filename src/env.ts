/**
 * 加载 .env —— 必须在任何读 process.env 的模块之前 import。
 *
 * 生产走 docker-compose 的 env_file，容器里没有 .env 文件，属正常情况。
 * 本地开发（npm run dev / check / probe）则依赖这里，否则配置永远读不到。
 *
 * 用 Node 内置的 loadEnvFile 而不是 dotenv 包：我们为了 node:sqlite
 * 本来就要求 Node >= 22.5，没必要为此多一个依赖。
 * 真实环境变量优先于 .env，这样 `FOO=x npm run dev` 能临时覆盖。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
if (existsSync(path)) {
  const before = { ...process.env };
  process.loadEnvFile(path);
  // loadEnvFile 会覆盖已有变量，这里把真实环境变量重新盖回去
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}
