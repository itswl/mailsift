import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './setup.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { attachmentLimitBytes } from '../src/smtp.js';
import { STRINGS } from '../src/web-strings.js';

/**
 * What the documents promise about sending, held to what the code does.
 *
 * An operator decides a limit, and a model decides what to send, from these
 * words; a sentence that contradicts the behaviour, or itself, misleads both.
 */
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Text as a reader takes it in: comment markers and line breaks gone, one space between words. */
const prose = (text: string): string => text.replace(/^[ \t]*(?:#|\*|\/\*\*|\*\/)[ \t]?/gm, '').replace(/\s+/g, ' ');

describe('the size of a letter', () => {
  it('says what providers take in a way the default limit is within', () => {
    // The default limit's files in base64, as the message travels.
    const travelling = Math.ceil(attachmentLimitBytes() / 3) * 4;
    for (const path of ['docs/configuration.md', 'src/smtp.ts']) {
      const text = prose(read(path));
      expect(text, path).not.toMatch(/refuse a message (?:over a size of their own, commonly )?(?:of )?about 25 MB as it travels/);
      const said = /25 MB of files on a message[^.]*?about (\d+) MB as (?:it|the message) travels/.exec(text);
      expect(said, path).not.toBeNull();
      expect(Number(said![1]) * 1_000_000, path).toBeGreaterThanOrEqual(travelling);
    }
  });
});

describe('docs/mcp.md', () => {
  it('says what the write token includes before what the page can do besides', () => {
    const text = prose(read('docs/mcp.md'));
    const includes = text.indexOf('That includes the two things that act for you in the world');
    expect(includes).toBeGreaterThan(-1);
    // "That" is what a browser signed in with the token has: the sentence before it says so.
    expect(text.slice(0, includes).trimEnd().endsWith('the same audit.')).toBe(true);
    expect(text.indexOf('The page can do one thing more')).toBeGreaterThan(includes);
  });

  it('says includeAttachments=true sends what the page sends by default, not the pictures of the body', () => {
    const mcp = prose(read('docs/mcp.md'));
    const skill = prose(read('.agents/skills/mailsift/SKILL.md'));
    expect(mcp).not.toContain('pictures shown within the original\'s body included');
    expect(mcp).toContain('`true` (the default) for what the page sends by default, every file but the pictures of the original\'s body');
    expect(skill).not.toMatch(/pictures shown within its body \(`inline: true` in `prepare_forward`: logos, icons\) included/);
    expect(skill).toContain('every file of the original but the pictures of its body');
  });

  it('promises a named file only where the server can name one', () => {
    const skill = prose(read('.agents/skills/mailsift/SKILL.md'));
    expect(skill).toContain('`forward_original_gone`');
    expect(skill).toContain('`forward_original_unavailable`');
    expect(prose(read('docs/mcp.md'))).toContain('no file is named');
  });
});

describe('docs/web-view.md', () => {
  it('says which letters go back to being drafts when the page is closed: those with files added from the device', () => {
    const text = prose(read('docs/web-view.md'));
    expect(text).not.toContain('a larger letter, or one with files, goes back to being a draft');
    expect(text).toContain('a larger letter, or one with files added from this device, goes back to being a draft');
  });

  it('says that a sender whose images always load is said so, with the way back, and where the list lives', () => {
    const web = prose(read('docs/web-view.md'));
    expect(web).toContain('the line above the message says so and offers "Not always", which takes the sender off the list again');
    expect(web).toContain('The list is kept by this browser alone, and signing out clears it');
    // The page has those words, in both of its languages.
    expect(STRINGS.en['reader.imagesAuto']).toContain('{sender}');
    expect(STRINGS.en['reader.stopImages']).toBe('Not always');
    expect(STRINGS['zh-CN']['reader.stopImages']).toBe('不再总是显示');
  });
});

describe('the endpoint on both protocol revisions', () => {
  it('docs/mcp.md names the revision a client is served on without asking, and says a GET is answered, not held open', () => {
    const text = prose(read('docs/mcp.md'));
    // The older one is the revision the SDK serves a client that does not ask what the server has.
    expect(text).toContain(`\`${LATEST_PROTOCOL_VERSION}\` and \`2026-07-28\``);
    expect(text).toMatch(/so a `GET` or a `DELETE` is answered `405`/);
  });

  it('says a line a client keeps open is cut when mailsift stops, and needs no block of its own in nginx', () => {
    const mcp = prose(read('docs/mcp.md'));
    expect(mcp).toContain('a keep-alive every fifteen seconds and nothing else');
    expect(mcp).toContain('it is cut when mailsift stops, as every connection is');
    const web = prose(read('docs/web-view.md'));
    expect(web).toContain('The MCP endpoint keeps a line open the same way');
    expect(web).toContain('`/mcp` needs no block of its own');
  });
});

describe('putting off until later', () => {
  it('says "Back now" brings a message back, and that only a cancelled reminder leaves it to its judgement', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    const skill = prose(read('.agents/skills/mailsift/SKILL.md'));
    expect(web).not.toContain('"Back now" cancels the reminder');
    expect(web).toContain('"Back now" brings the message back as if its time had come');
    expect(mcp).not.toContain('the message is in `needs_you` again if it was judged to matter (critical or notified), and otherwise only in `list_mail`');
    expect(mcp).toContain('arrived within the last 30 days');
    expect(mcp).toContain('`until: "now"`');
    expect(skill).not.toContain('The message is back in `needs_you` at once if it was judged to matter');
    expect(skill).toContain('`until: "now"`');
  });

  it('does not say codes and sign-in links are never in the queue, when one put off comes back', () => {
    const skill = prose(read('.agents/skills/mailsift/SKILL.md'));
    expect(skill).not.toContain('Verification codes, sign-in links and mailsift\'s own alerts and digests are never in it');
    expect(skill).toContain('unless the owner put one off and its time has come');
    expect(prose(read('docs/web-view.md'))).toContain('one you put off comes back like anything else');
  });
});

describe('the owner\'s sent mail', () => {
  it('is documented where it is set, said to be local, for the conversation only, and never sent to the model', () => {
    const settings = prose(read('src/settings-catalog.ts'));
    expect(settings).toContain("key: 'SENT_MAIL_ENABLED'");
    expect(settings).toContain("key: 'SENT_LOOKBACK_DAYS'");
    const config = prose(read('docs/configuration.md'));
    expect(config).toContain('It is used for the conversation only. It is never judged, never sent to the model');
    expect(config).toContain('What was stored before stays, and still shows in its conversations, until retention removes it');
    expect(prose(read('docs/web-view.md'))).toContain('used for the conversation only: it is never judged, never sent to the model');
    expect(prose(read('docs/mcp.md'))).toContain('used for the conversation only, and never judged or sent to the model');
    expect(prose(read('.agents/skills/mailsift/SKILL.md'))).toContain('it is never judged or sent to the model');
    // sentCount counts the window, wherever it is described.
    expect(prose(read('docs/mcp.md'))).toContain('how many of your own messages it holds in the window (`sentCount`)');
    expect(prose(read('.agents/skills/mailsift/SKILL.md'))).toContain('holds within the window it lists (`sentCount`)');
    // Withheld is told apart from quiet digest mail.
    expect(prose(read('docs/mcp.md'))).toContain('it is not quiet digest mail');
    expect(prose(read('.agents/skills/mailsift/SKILL.md'))).toContain('`withheld: true` means it was judged worth a notification');
    expect(prose(read('docs/web-view.md'))).toContain('one that would have been notified is not listed in the digest either');
    // The audit still records only that a letter left; the letter is kept for its conversation.
    expect(prose(read('docs/web-view.md'))).not.toContain('What is recorded about a sent message is that one left');
  });
});

describe('the whole mailbox', () => {
  it('does not say live mail never goes to the model, and says Draft with AI sends it when pressed', () => {
    const web = prose(read('docs/web-view.md'));
    expect(web).not.toContain('nothing of it is stored, judged, sent to the model or put in the queue');
    expect(web).toContain('nothing of it goes to the model unless you ask, with Draft with AI');
    expect(web).toContain('Pressing it is asking for the text of the message being answered to go to the model');
    expect(web).toContain('its text reaches the model then, because you asked, and at no other time');
  });

  it('says which listed message is a stored record, and that a copy or a look-alike is not', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    const skill = prose(read('.agents/skills/mailsift/SKILL.md'));
    expect(web).toContain('It is that record only where the record says it is');
    expect(mcp).toContain('A listed message is the stored record only where the record says it is');
    expect(mcp).toContain('signed by this server with a key kept in the state database');
    expect(skill).toContain('Pass the handle, never the item\'s `messageId`');
    // get_mail takes a handle, as the server's instructions say every messageId tool does.
    expect(mcp).toContain('A handle can be given wherever a tool takes a `messageId`: `get_mail`');
  });

  it('says what a batch answers while the mailbox is still at it, and what the owner filing a message does to the poll', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    expect(mcp).toContain('or `pending` when the mailbox had not answered for it');
    expect(mcp).toContain('`alreadyDone` for a `snooze` of one marked done');
    expect(web).toContain('is written down as filed by you where it lands');
    expect(mcp).toContain('is written down as filed by the owner where it lands');
    expect(web).toContain('Undo acts on the batch it undoes and on nothing else');
  });
});

describe('the whole mailbox, after a second review', () => {
  it('says a stored message is found elsewhere only from its own sender, and a look-alike is not taken for it', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    expect(web).toContain('found anywhere else, a message with its Message-ID is it only when it is from the same sender');
    expect(mcp).toContain('a look-alike with its Message-ID is answered `NOT_FOUND`');
  });

  it('says how many search connections a mailbox has, and that a slow search is said as slow', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    expect(web).toContain('A mailbox has at most two such connections');
    expect(web).toContain('is stopped and said to be slow');
    expect(mcp).toContain('A mailbox has at most two such connections');
    expect(mcp).toContain('the hint to narrow the search to one folder');
  });

  it('says Undo undoes all of a batch, and that a reload adds nothing to the history', () => {
    const web = prose(read('docs/web-view.md'));
    expect(web).toContain('and on all of it, whatever the page has loaded or left since');
    expect(web).toContain('A reload, or the installed app coming back, adds nothing to the history.');
    expect(prose(read('docs/mcp.md'))).toContain('one audit row for every id asked about');
  });
});

describe('the whole mailbox, after a third review', () => {
  it('says a listing ties a record only to its first message from its sender, and MCP reads a record as its key finds it', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    expect(web).toContain('its first message in that folder from its sender');
    expect(web).toContain('A later copy from the same sender is not it');
    expect(mcp).toContain('only its first message in that folder from its sender');
    expect(mcp).toContain('so a look-alike that borrowed its Message-ID is answered as not found');
  });

  it('says the reader keeps the open message over a reload and never jumps to one nobody chose', () => {
    const web = prose(read('docs/web-view.md'));
    expect(web).toContain('the message open in the reader stays open, even when it is no longer on the first page');
    expect(web).toContain('it never jumps to a message you did not choose');
  });
});

describe('the whole mailbox, after a fourth review', () => {
  it('says a listing asks once per page, not where search cannot say, and an action settles it there', () => {
    const web = prose(read('docs/web-view.md'));
    const mcp = prose(read('docs/mcp.md'));
    expect(web).toContain('in one search for the whole page');
    expect(web).toContain('whether the record\'s own lookup finds this very message, and if so keeps the record\'s books');
    expect(mcp).toContain('QQ\'s search cannot, so it is not asked there');
  });

  it('says a stale message is put down on every path, and a narrow window puts down what it no longer shows', () => {
    const web = prose(read('docs/web-view.md'));
    expect(web).toContain('whether on an action, a batch, Reply or Forward, or reading it');
    expect(web).toContain('so keys act only on what is on show');
  });
});
