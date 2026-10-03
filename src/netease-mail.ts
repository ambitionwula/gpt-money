import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { decryptSecret } from './crypto.js';
import { MailConnection } from './types.js';

const HOSTS: Record<MailConnection['provider'], string> = {
  '163': 'imap.163.com',
  '126': 'imap.126.com',
  yeah: 'imap.yeah.net'
};

export function providerForEmail(email: string): MailConnection['provider'] | undefined {
  const domain = email.toLowerCase().split('@')[1];
  if (domain === '163.com') return '163';
  if (domain === '126.com') return '126';
  if (domain === 'yeah.net') return 'yeah';
  return undefined;
}

function senderAllowed(from: string): boolean {
  return config.allowedSenders.length === 0 || config.allowedSenders.some((allowed) => from.includes(allowed));
}

function extractCode(text: string): string | undefined {
  const keyword = '(?:验证码|校验码|动态码|临时验证码|临时码|verification\\s+code|security\\s+code|one[-\\s]?time\\s+(?:code|password)|otp)';
  const contextualPatterns = [
    new RegExp(`${keyword}[^\\d]{0,30}(\\d{4,8})(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)(\\d{4,8})[^\\d]{0,30}${keyword}`, 'i')
  ];

  for (const pattern of contextualPatterns) {
    const match = text.match(pattern);
    if (match?.[1] && !/^20\d{2}$/.test(match[1])) return match[1];
  }

  const matches = text.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [];
  return matches.find((value) => !/^20\d{2}$/.test(value));
}

export async function findLatestOtp(connection: MailConnection, after: Date): Promise<string | undefined> {
  const client = new ImapFlow({
    host: HOSTS[connection.provider],
    port: 993,
    secure: true,
    auth: { user: connection.email, pass: decryptSecret(connection.encryptedAppPassword) },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // IMAP SEARCH SINCE is date-granular on many servers, so it can return
      // messages from earlier on the same day. Check internalDate as well and
      // inspect the newest UIDs first to avoid returning an older OTP.
      const searchResult = await client.search({ since: after });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      const recentUids = uids.slice(-20).reverse();
      for (const uid of recentUids) {
        for await (const message of client.fetch([uid], { source: true, envelope: true, internalDate: true })) {
          const receivedAt = message.internalDate ? new Date(message.internalDate).getTime() : undefined;
          // Allow a small precision/clock tolerance because IMAP timestamps may
          // not preserve milliseconds.
          if (!receivedAt || receivedAt < after.getTime() - 2_000) continue;
          const sender = message.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
          if (!senderAllowed(sender) || !message.source) continue;
          const parsed = await simpleParser(message.source);
          const content = `${parsed.subject ?? ''}\n${parsed.text ?? ''}`;
          const code = extractCode(content);
          if (code) return code;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return undefined;
}

export async function waitForOtp(connection: MailConnection, after: Date, expiresAt: number, signal?: AbortSignal): Promise<string | undefined> {
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return undefined;
    const code = await findLatestOtp(connection, after);
    if (code) return code;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, config.OTP_POLL_INTERVAL_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return undefined;
}
