/**
 * Puts the skill where the server reads it at run time: dist/skills, beside
 * the compiled dist/src (see src/mcp-skills.ts).
 *
 * .agents/skills/ is the only copy anyone edits. This is the copy that ships,
 * and the one the image is built from: `npm run build` runs this after tsc.
 *
 * Files are copied one by one, so where each goes does not depend on what a
 * former build left behind. The one argument says where to put them, for the
 * test; without it they go to dist/skills.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, '.agents', 'skills');
const to = process.argv[2] ?? join(root, 'dist', 'skills');

const copy = (source, target) => {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copy(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) copyFileSync(join(source, entry.name), join(target, entry.name));
  }
};
copy(from, to);
