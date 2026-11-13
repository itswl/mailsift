import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './setup.js';
import { attachmentLimitBytes } from '../src/smtp.js';

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
    for (const path of ['.env.example', 'docs/configuration.md', 'src/smtp.ts']) {
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
});
