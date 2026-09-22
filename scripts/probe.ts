#!/usr/bin/env node
/**
 * Connectivity and folder probe.
 *
 * Run this after adding a mailbox. It lists real folders and message counts,
 * identifies spam, and reports folders with mail that are not monitored.
 */
import '../src/env.js'; // Must run first so .env is loaded.
import { parseArgs } from 'node:util';
import { loadConfig, type Account } from '../src/config.js';
import { connect, listFolders, targetFolders } from '../src/imap/client.js';
import { excludedFromAll, findSpamFolder, toFolder } from '../src/imap/folders.js';

const RECENT_DAYS = 30;

function pad(text: string, width: number): string {
  // Count wide Unicode characters as two columns for aligned tables.
  const visual = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - visual));
}

async function probeAccount(account: Account, withCounts: boolean): Promise<boolean> {
  console.log(`\n=== ${account.name} (${account.username}) [${account.provider}/${account.auth}] ===`);
  let client;
  try {
    client = await connect(account);
  } catch (error) {
    console.log(`❌ Failed: ${error}`);
    return false;
  }

  try {
    const entries = await listFolders(client);
    const folders = entries.map(toFolder);
    const specialUseByPath = new Map(entries.map((e) => [e.path, e.specialUse ?? '']));
    const watched = new Set((await targetFolders(client, account)).map((f) => f.path));
    console.log(`Connected; ${folders.length} folders found.`);
    console.log(
      client.capabilities.has('IDLE')
        ? 'IDLE: supported (IMAP_IDLE_ENABLED=true gives real-time wake-ups for this account)'
        : 'IDLE: not advertised (this account stays on scheduled polling even with IMAP_IDLE_ENABLED=true)',
    );
    console.log(`${pad('Folder', 30)}${pad('Total', 8)}${pad(`Last ${RECENT_DAYS}d`, 10)}Status`);

    let missed = 0;
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

    for (const folder of folders) {
      if (!folder.selectable) {
        console.log(`${pad(folder.path, 30)}${pad('—', 8)}${pad('—', 10)}(container; not selectable)`);
        continue;
      }
      let tag = watched.has(folder.path) ? '✅ monitored' : '   not monitored';
      if (!withCounts) {
        console.log(`${pad(folder.path, 30)}${tag}`);
        continue;
      }
      try {
        const lock = await client.getMailboxLock(folder.path, { readOnly: true });
        let total = 0;
        let recent = 0;
        try {
          total = (await client.search({ all: true }, { uid: true }) || []).length;
          recent = (await client.search({ since }, { uid: true }) || []).length;
        } finally {
          lock.release();
        }
        // Trash and sent folders are intentional exclusions, not blind spots.
        const isBlindSpot =
          !watched.has(folder.path) &&
          recent > 0 &&
          !excludedFromAll(folder, specialUseByPath.get(folder.path));
        if (isBlindSpot) {
          tag = '⚠️ not monitored (new mail)';
          missed += recent;
        }
        console.log(`${pad(folder.path, 30)}${pad(String(total), 8)}${pad(String(recent), 10)}${tag}`);
      } catch {
        console.log(`${pad(folder.path, 30)}${pad('?', 8)}${pad('?', 10)}unreadable`);
      }
    }

    const spam = findSpamFolder(folders);
    console.log(
      spam
        ? `\nSpam: ${JSON.stringify(spam.path)}`
        : '\n❌ No spam folder detected. Add its name to MAIL_ACCOUNT_N_FOLDERS.',
    );
    console.log(`This configuration scans: ${[...watched].join(', ')}`);

    if (missed) {
      console.log(`\n⚠️  ${missed} messages from the last ${RECENT_DAYS} days are in unmonitored folders.`);
      console.log('   Server-side rules may move messages before they reach INBOX.');
      console.log('   To scan everything, set MAIL_ACCOUNT_N_FOLDERS=all in .env.');
      console.log('   (all excludes sent, drafts, trash, and Gmail All Mail.)');
    }
    return true;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { account: { type: 'string' }, 'no-counts': { type: 'boolean', default: false } },
    allowPositionals: false,
  });

  let accounts;
  try {
    accounts = loadConfig().accounts;
  } catch (error) {
    console.log(`❌ Configuration error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (values.account) {
    accounts = accounts.filter((a) => a.username === values.account);
    if (accounts.length === 0) {
      console.log(`❌ Account not configured: ${values.account}`);
      return 1;
    }
  }

  let failed = 0;
  for (const account of accounts) {
    if (!(await probeAccount(account, !values['no-counts']))) failed += 1;
  }
  console.log(`\nComplete: ${accounts.length - failed}/${accounts.length} accounts connected.`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
