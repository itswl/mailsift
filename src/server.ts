/**
 * The server's entry point: a small supervisor around src/main.
 *
 * Saving settings on the web page restarts the service so every module reads
 * them afresh. main exits with RESTART_EXIT_CODE for that, and this process
 * starts it again at once, which works the same under Docker, systemd and a
 * plain `node`. Any other exit is passed on, so a crash still reaches the
 * container's or the unit's restart policy. SIGTERM and SIGINT are passed to
 * the service, which finishes its current poll before it exits.
 *
 * Deliberately imports nothing of mailsift: this process stays small and never
 * opens the database or a mailbox.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 75;
const here = fileURLToPath(import.meta.url);
// Beside this file, with its extension: main.js in dist, main.ts under tsx.
const entry = join(dirname(here), `main${extname(here)}`);

let child: ChildProcess | undefined;
let stopping: NodeJS.Signals | undefined;
const restarts: number[] = [];

function forward(signal: NodeJS.Signals): void {
  stopping = signal;
  if (child && child.exitCode === null) child.kill(signal);
  else process.exit(0);
}
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

function run(): Promise<number> {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, MAILSIFT_SUPERVISED: '1' },
    });
    child.once('error', (error) => {
      console.error(`mailsift: could not start the service: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}

for (;;) {
  const code = await run();
  child = undefined;
  if (stopping || code !== RESTART_EXIT_CODE) {
    process.exit(stopping && code === RESTART_EXIT_CODE ? 0 : code);
  }
  // A restart loop (settings that crash the service the moment it reads them
  // would end in one) slows down instead of spinning.
  const now = Date.now();
  restarts.push(now);
  while (restarts.length && now - restarts[0]! > 60_000) restarts.shift();
  if (restarts.length > 5) await new Promise((resolve) => setTimeout(resolve, 5000));
  console.error('mailsift: restarting to apply settings…');
}
