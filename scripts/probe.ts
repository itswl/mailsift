#!/usr/bin/env node
/**
 * 连通性 + 文件夹探测。
 *
 * 接入新邮箱后第一件事跑这个：打印每个账号的真实文件夹列表、邮件量，
 * 并指出哪个被识别成垃圾箱、哪些文件夹有邮件却没被监控（盲区）。
 */
import '../src/env.js'; // 必须最先执行：把 .env 灌进 process.env
import { parseArgs } from 'node:util';
import { loadConfig, type Account } from '../src/config.js';
import { connect, listFolders, targetFolders } from '../src/imap/client.js';
import { excludedFromAll, findSpamFolder, toFolder } from '../src/imap/folders.js';

const RECENT_DAYS = 30;

function pad(text: string, width: number): string {
  // 中文按两个宽度算，否则表格会歪
  const visual = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - visual));
}

async function probeAccount(account: Account, withCounts: boolean): Promise<boolean> {
  console.log(`\n=== ${account.name} (${account.username}) [${account.provider}/${account.auth}] ===`);
  let client;
  try {
    client = await connect(account);
  } catch (error) {
    console.log(`❌ 失败: ${error}`);
    return false;
  }

  try {
    const entries = await listFolders(client);
    const folders = entries.map(toFolder);
    const specialUseByPath = new Map(entries.map((e) => [e.path, e.specialUse ?? '']));
    const watched = new Set((await targetFolders(client, account)).map((f) => f.path));
    console.log(`连接成功，共 ${folders.length} 个文件夹`);
    console.log(`${pad('文件夹', 30)}${pad('总数', 8)}${pad(`近${RECENT_DAYS}天`, 10)}状态`);

    let missed = 0;
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

    for (const folder of folders) {
      if (!folder.selectable) {
        console.log(`${pad(folder.path, 30)}${pad('—', 8)}${pad('—', 10)}（容器，不可选）`);
        continue;
      }
      let tag = watched.has(folder.path) ? '✅ 已监控' : '   未监控';
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
        // 回收站/已发送这些本来就该跳过，不算盲区
        const isBlindSpot =
          !watched.has(folder.path) &&
          recent > 0 &&
          !excludedFromAll(folder, specialUseByPath.get(folder.path));
        if (isBlindSpot) {
          tag = '⚠️ 未监控（有新邮件）';
          missed += recent;
        }
        console.log(`${pad(folder.path, 30)}${pad(String(total), 8)}${pad(String(recent), 10)}${tag}`);
      } catch {
        console.log(`${pad(folder.path, 30)}${pad('?', 8)}${pad('?', 10)}打不开`);
      }
    }

    const spam = findSpamFolder(folders);
    console.log(
      spam
        ? `\n垃圾箱: ${JSON.stringify(spam.path)}`
        : '\n❌ 没识别出垃圾箱。上面列表里若能看到，把名字写进 MAIL_ACCOUNT_N_FOLDERS。',
    );
    console.log(`本配置将扫描: ${[...watched].join(', ')}`);

    if (missed) {
      console.log(`\n⚠️  近 ${RECENT_DAYS} 天有 ${missed} 封邮件在未监控的文件夹里。`);
      console.log('   服务器端的收信规则会把邮件直接移走，这些信从未经过 INBOX。');
      console.log('   要全都看：把 .env 里该账号的 MAIL_ACCOUNT_N_FOLDERS 设成 all');
      console.log('   （all 会自动排除已发送、草稿、回收站和 Gmail 的 All Mail）');
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
    console.log(`❌ 配置错误: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (values.account) {
    accounts = accounts.filter((a) => a.username === values.account);
    if (accounts.length === 0) {
      console.log(`❌ 配置里没有这个账号: ${values.account}`);
      return 1;
    }
  }

  let failed = 0;
  for (const account of accounts) {
    if (!(await probeAccount(account, !values['no-counts']))) failed += 1;
  }
  console.log(`\n完成：${accounts.length - failed}/${accounts.length} 个账号连通`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
