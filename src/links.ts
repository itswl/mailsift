/**
 * 生成"打开这封邮件"的链接。
 *
 * 手机上不装邮件客户端的话，卡片必须能一键跳到原文。各家能做到的精度
 * 不一样，这里如实区分——Gmail 能按 Message-ID 精确定位，其余只能给
 * 网页版入口，所以链接文案也要跟着变，不能都写成"打开这封邮件"。
 */
export interface MailLink {
  url: string;
  label: string;
  /** 能否定位到具体这一封 */
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
          label: '在 Gmail 中打开这封',
          exact: true,
        };
      }
      return { url: 'https://mail.google.com/', label: '打开 Gmail', exact: false };
    }
    case 'outlook':
      return { url: 'https://outlook.live.com/mail/0/', label: '打开 Outlook 邮箱', exact: false };
    case 'qq':
      return { url: 'https://mail.qq.com/', label: '打开 QQ 邮箱', exact: false };
    case 'qq_biz':
      return { url: 'https://exmail.qq.com/', label: '打开腾讯企业邮', exact: false };
    case '163':
      return { url: 'https://mail.163.com/', label: '打开网易邮箱', exact: false };
    case '126':
      return { url: 'https://mail.126.com/', label: '打开 126 邮箱', exact: false };
    case 'icloud':
      return { url: 'https://www.icloud.com/mail/', label: '打开 iCloud 邮箱', exact: false };
    default:
      return undefined;
  }
}
