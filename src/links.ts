/**
 * Build a link for opening a message.
 *
 * Cards should open the original message even when the recipient has no mail app.
 * Gmail can locate a message by Message-ID; other providers only expose a web inbox.
 */
export interface MailLink {
  url: string;
  label: string;
  /** Whether the link locates this exact message. */
  exact: boolean;
}

export function buildLink(provider: string, account: string, messageId: string): MailLink | undefined {
  switch (provider) {
    case 'gmail':
    case 'gmail_pw': {
      const id = messageId.trim().replace(/^</, '').replace(/>$/, '');
      if (id && !id.startsWith('generated-')) {
        const query = encodeURIComponent(`rfc822msgid:${id}`);
        return {
          url: `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#search/${query}`,
          label: 'Open in Gmail',
          exact: true,
        };
      }
      return { url: 'https://mail.google.com/', label: 'Open Gmail', exact: false };
    }
    case 'outlook':
      return { url: 'https://outlook.live.com/mail/0/', label: 'Open Outlook Mail', exact: false };
    case 'qq':
      return { url: 'https://mail.qq.com/', label: 'Open QQ Mail', exact: false };
    case 'qq_biz':
      return { url: 'https://exmail.qq.com/', label: 'Open Tencent Exmail', exact: false };
    case '163':
      return { url: 'https://mail.163.com/', label: 'Open 163 Mail', exact: false };
    case '126':
      return { url: 'https://mail.126.com/', label: 'Open 126 Mail', exact: false };
    case 'icloud':
      return { url: 'https://www.icloud.com/mail/', label: 'Open iCloud Mail', exact: false };
    default:
      return undefined;
  }
}
