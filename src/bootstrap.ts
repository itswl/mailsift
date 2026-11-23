/**
 * Load the stored settings before any other module reads its configuration.
 *
 * Imported for its side effect, right after env.js, by every entry point that
 * runs against the server's data (main, the MCP server, the tools in scripts/).
 * Several modules read process.env once when they load, so this has to come
 * first. A failure is kept rather than thrown, so main can say what is wrong
 * in plain words instead of a stack trace from an import.
 */
import { authorizedUsernames } from './imap/auth.js';
import { ensureAccessTokens, readSettings } from './services/settings-store.js';
import { applySettings, rememberBootState } from './services/settings-runtime.js';

// The database holds message metadata and encrypted credentials: nothing
// mailsift creates should be readable by other users of the machine.
process.umask(0o077);

export let bootstrapError: Error | undefined;

try {
  ensureAccessTokens();
  const doc = readSettings();
  const authorized = authorizedUsernames();
  applySettings(doc, authorized);
  rememberBootState(doc, authorized);
} catch (error) {
  bootstrapError = error instanceof Error ? error : new Error(String(error));
}
