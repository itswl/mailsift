/**
 * The skill: how the tools are meant to be used together, and where their
 * limits are. The MCP server serves it itself (the MCP Skills extension,
 * SEP-2640), so a host that supports skills finds it where it looks, and
 * loads it, without anyone copying a file to the host's machine.
 *
 * .agents/skills/mailsift/SKILL.md is the only copy anyone edits. The build
 * puts a copy of it beside the compiled server (scripts/copy-skills.mjs:
 * dist/skills), and the server reads it there, so what a host loads is the
 * copy that shipped with the tools it describes. Straight from the repository,
 * under tsx, there is no build: the repository's own copy is read.
 *
 * The files are read once, as the server starts, and every server is given
 * what that read found. startMcpHttp makes a new server for each request, and
 * one catalog serves any number of them. Nothing here changes while the
 * process runs: a changed skill arrives with a new image.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

/** The skill's own file, as a client asks for it. */
export const SKILL_URI = 'skill://mailsift/SKILL.md';

/**
 * What the server says of the skill in its instructions, where it goes first:
 * a host that loads skills itself brings the skill in when it is wanted, and
 * one that only reads resources is told where it is. First, because a host may
 * keep only the start of a server's instructions (INSTRUCTIONS).
 */
export const SKILL_INSTRUCTIONS =
  `The skill at ${SKILL_URI} says how these tools are meant to be used together. ` +
  'Read it before anything more than a single lookup, and before a tool that acts on mail or changes a setting.\n';

const here = dirname(fileURLToPath(import.meta.url));

/** dist/skills in a build (this file is dist/src/mcp-skills.js then); under tsx, the repository's own .agents/skills. */
export function skillsDirectory(): string {
  const built = join(here, '..', 'skills');
  return existsSync(built) ? built : join(here, '..', '.agents', 'skills');
}

/**
 * Reads the skill files, once. Throws when they cannot be read, and when what
 * was read is not something a host can be given: under `strict` a problem in
 * the skill is an error, where it would otherwise be a warning and the skill
 * quietly left out.
 */
export async function loadSkillCatalog(directory: string = skillsDirectory()): Promise<SkillCatalog> {
  const catalog = await loadSkills(directory, { strict: true });
  if (!catalog.entries.some((entry) => entry.uri === SKILL_URI)) {
    throw new Error(`there is no skill at ${SKILL_URI} under ${directory}`);
  }
  return catalog;
}

/**
 * For the server's start: the skill, or nothing when it could not be read.
 *
 * Mail is what this server is for, and every tool works without the skill. So
 * a skill that is missing or broken is said once, where the container's logs
 * go, and the server runs on without the extension. What it never does is say
 * it serves a skill it has not got: a server made without a catalog declares
 * no extension, and its instructions do not speak of one.
 */
export async function skillCatalogOrNone(directory: string = skillsDirectory()): Promise<SkillCatalog | undefined> {
  try {
    return await loadSkillCatalog(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`The skill could not be read from ${directory}, and MCP runs without it: ${reason}`);
    return undefined;
  }
}

/**
 * As far as the extension is concerned, a server is this much: what its
 * attach() asks of one (SDK 2.4.0), and nothing else is passed on. An SDK
 * release in which it asks for more fails the tests, not a request.
 */
type AttachTarget = Pick<McpServer, 'isConnected' | 'server' | 'registerResource'>;

/**
 * Serves the skill on one server, before it is connected: its files as
 * resources under skill://, and skills/list, skills/get and
 * resources/directory/read, which the SDK's extension registers itself.
 *
 * It registers its one resource through the server's registerResource, so it
 * is handed this server's own (createServer's). A skill file that is read is
 * counted while it is being read, its failures are typed, and it leaves an
 * audit row, as every other resource read does. skills/list and skills/get
 * carry a skill's name, description and file list and none of its text, so
 * they are listings, and are not audited, as tools/list is not.
 */
export function attachSkills(
  server: McpServer,
  catalog: SkillCatalog,
  registerResource: McpServer['registerResource'],
  audited: (uri: string, ok: boolean) => void,
): void {
  const target: AttachTarget = {
    isConnected: () => server.isConnected(),
    server: server.server,
    registerResource: ((name: string, ...rest: unknown[]) => {
      const read = rest.pop();
      return registerResource(
        name as never,
        ...(rest as [never, never]),
        (async (...args: unknown[]) => {
          const uri = (args[0] as URL).href;
          try {
            const result = await (read as (...read: unknown[]) => Promise<unknown>)(...args);
            audited(uri, true);
            return result;
          } catch (error) {
            audited(uri, false);
            throw error;
          }
        }) as never,
      );
    }) as McpServer['registerResource'],
  };
  catalog.attach(target as McpServer);
}
