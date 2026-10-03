import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  DATABASE_PATH: z.string().trim().min(1).default('data/gpt-money.sqlite'),
  MASTER_KEY_HEX: z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY_HEX must be 32 bytes in hex'),
  OTP_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  OTP_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(30_000).default(6000),
  OTP_LOOKBACK_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  OTP_ALLOWED_SENDERS: z.string().optional().default(''),
  ADMIN_USERNAME: z.string().default('zyz255113'),
  ADMIN_PASSWORD: z.string().default('Zyz255113@')
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration. Copy .env.example to .env and fill it in.');
}

export const config = {
  ...parsed.data,
  masterKey: Buffer.from(parsed.data.MASTER_KEY_HEX, 'hex'),
  allowedSenders: parsed.data.OTP_ALLOWED_SENDERS
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
};
