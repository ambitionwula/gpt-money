declare module 'mailparser' {
  export function simpleParser(source: Buffer): Promise<{
    subject?: string;
    text?: string;
  }>;
}
