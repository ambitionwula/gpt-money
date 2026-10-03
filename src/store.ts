import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { Announcement, MailAssignment, MailAssignmentSource, MailConnection, ManagedMailAccount, OtpRequest, PaymentOrder, PaymentPlan, PaymentSettings, SupportAiConfig, SupportMessage, SupportMessageSender, SupportTicket, SupportTicketStatus, User } from './types.js';

type SqlRow = Record<string, unknown>;
const SUBSCRIPTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAYMENT_PLAN_ID = 'PLAN-DEFAULT-1';

const databasePath = path.resolve(process.cwd(), config.DATABASE_PATH);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    admin_level TEXT CHECK (admin_level IN ('primary', 'secondary')),
    admin_active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    paid INTEGER NOT NULL DEFAULT 0,
    paid_until INTEGER,
    subscription_plan_id TEXT,
    max_mail_accounts INTEGER NOT NULL DEFAULT 1,
    can_view_mail_credentials INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id TEXT,
    amount_fen INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'closed')),
    payment_method TEXT,
    provider_trade_no TEXT,
    admin_note TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_payment_orders_user
    ON payment_orders (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
    ON auth_sessions (user_id, expires_at DESC);

  CREATE TABLE IF NOT EXISTS payment_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    seat_count INTEGER NOT NULL CHECK (seat_count > 0),
    display_seat_count INTEGER,
    amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    active INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_settings (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    gateway_type TEXT NOT NULL DEFAULT 'epay' CHECK (gateway_type IN ('epay', 'manual')),
    gateway_url TEXT NOT NULL DEFAULT '',
    callback_base_url TEXT NOT NULL DEFAULT '',
    return_url TEXT NOT NULL DEFAULT '',
    merchant_id TEXT NOT NULL DEFAULT '',
    encrypted_merchant_key TEXT NOT NULL DEFAULT '',
    min_amount_fen INTEGER NOT NULL DEFAULT 100,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mail_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    encrypted_app_password TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('163', '126', 'yeah')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS managed_mail_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    encrypted_app_password TEXT NOT NULL,
    encrypted_login_password TEXT,
    provider TEXT NOT NULL CHECK (provider IN ('163', '126', 'yeah')),
    note TEXT NOT NULL DEFAULT '',
    max_users INTEGER NOT NULL CHECK (max_users > 0),
    active INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mail_assignments (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'admin')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_id),
    FOREIGN KEY (account_id) REFERENCES managed_mail_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mail_assignments_account
    ON mail_assignments (account_id);

  CREATE TABLE IF NOT EXISTS otp_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'found', 'expired', 'failed')),
    code_hash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_otp_requests_user
    ON otp_requests (user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_otp_requests_connection
    ON otp_requests (connection_id, status, expires_at);

  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'pending', 'closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_support_tickets_user
    ON support_tickets (user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin', 'ai')),
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    attachment_path TEXT,
    attachment_name TEXT,
    attachment_mime TEXT,
    attachment_size INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
    ON support_messages (ticket_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS support_ai_configs (
    id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    starts_at INTEGER NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_announcements_active
    ON announcements (active, priority DESC, starts_at DESC);
`);

const supportMessageColumns = db.prepare('PRAGMA table_info(support_messages)').all() as Array<{ name: string }>;
if (!supportMessageColumns.some((column) => column.name === 'attachment_path')) {
  db.exec('ALTER TABLE support_messages ADD COLUMN attachment_path TEXT');
}
if (!supportMessageColumns.some((column) => column.name === 'attachment_name')) {
  db.exec('ALTER TABLE support_messages ADD COLUMN attachment_name TEXT');
}
if (!supportMessageColumns.some((column) => column.name === 'attachment_mime')) {
  db.exec('ALTER TABLE support_messages ADD COLUMN attachment_mime TEXT');
}
if (!supportMessageColumns.some((column) => column.name === 'attachment_size')) {
  db.exec('ALTER TABLE support_messages ADD COLUMN attachment_size INTEGER');
}

const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
if (!userColumns.some((column) => column.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}
if (!userColumns.some((column) => column.name === 'paid_until')) {
  db.exec('ALTER TABLE users ADD COLUMN paid_until INTEGER');
}
if (!userColumns.some((column) => column.name === 'max_mail_accounts')) {
  db.exec('ALTER TABLE users ADD COLUMN max_mail_accounts INTEGER NOT NULL DEFAULT 1');
}
if (!userColumns.some((column) => column.name === 'subscription_plan_id')) {
  db.exec('ALTER TABLE users ADD COLUMN subscription_plan_id TEXT');
}
if (!userColumns.some((column) => column.name === 'can_view_mail_credentials')) {
  db.exec('ALTER TABLE users ADD COLUMN can_view_mail_credentials INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some((column) => column.name === 'admin_level')) {
  db.exec("ALTER TABLE users ADD COLUMN admin_level TEXT CHECK (admin_level IN ('primary', 'secondary'))");
}
if (!userColumns.some((column) => column.name === 'admin_active')) {
  db.exec('ALTER TABLE users ADD COLUMN admin_active INTEGER NOT NULL DEFAULT 1');
}

const paymentOrderColumns = db.prepare('PRAGMA table_info(payment_orders)').all() as Array<{ name: string }>;
if (!paymentOrderColumns.some((column) => column.name === 'plan_id')) {
  db.exec('ALTER TABLE payment_orders ADD COLUMN plan_id TEXT');
}
if (!paymentOrderColumns.some((column) => column.name === 'payment_method')) {
  db.exec('ALTER TABLE payment_orders ADD COLUMN payment_method TEXT');
}
if (!paymentOrderColumns.some((column) => column.name === 'provider_trade_no')) {
  db.exec('ALTER TABLE payment_orders ADD COLUMN provider_trade_no TEXT');
}
if (!paymentOrderColumns.some((column) => column.name === 'admin_note')) {
  db.exec('ALTER TABLE payment_orders ADD COLUMN admin_note TEXT');
}

const paymentPlanColumns = db.prepare('PRAGMA table_info(payment_plans)').all() as Array<{ name: string }>;
if (!paymentPlanColumns.some((column) => column.name === 'display_seat_count')) {
  db.exec('ALTER TABLE payment_plans ADD COLUMN display_seat_count INTEGER');
}
if (!paymentPlanColumns.some((column) => column.name === 'deleted')) {
  db.exec('ALTER TABLE payment_plans ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
}
db.prepare(`
  UPDATE payment_plans
  SET display_seat_count = seat_count
  WHERE display_seat_count IS NULL
`).run();

db.prepare(`
  INSERT OR IGNORE INTO payment_plans
    (id, name, seat_count, display_seat_count, amount_fen, duration_days, active, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(DEFAULT_PAYMENT_PLAN_ID, '单人套餐', 1, 1, 990, 30, 1, Date.now(), Date.now());
db.prepare(`
  INSERT OR IGNORE INTO payment_settings
    (id, enabled, gateway_type, gateway_url, callback_base_url, return_url, merchant_id, encrypted_merchant_key, min_amount_fen, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('default', 0, 'epay', '', '', '', '', '', 100, Date.now());
db.prepare(`
  UPDATE users
  SET subscription_plan_id = ?
  WHERE paid = 1 AND subscription_plan_id IS NULL
`).run(DEFAULT_PAYMENT_PLAN_ID);

const managedAccountColumns = db.prepare('PRAGMA table_info(managed_mail_accounts)').all() as Array<{ name: string }>;
if (!managedAccountColumns.some((column) => column.name === 'encrypted_login_password')) {
  db.exec('ALTER TABLE managed_mail_accounts ADD COLUMN encrypted_login_password TEXT');
}
if (!managedAccountColumns.some((column) => column.name === 'expires_at')) {
  db.exec('ALTER TABLE managed_mail_accounts ADD COLUMN expires_at INTEGER');
}
if (!managedAccountColumns.some((column) => column.name === 'note')) {
  db.exec("ALTER TABLE managed_mail_accounts ADD COLUMN note TEXT NOT NULL DEFAULT ''");
}
db.prepare(`
  UPDATE managed_mail_accounts
  SET expires_at = created_at + ?
  WHERE expires_at IS NULL
`).run(SUBSCRIPTION_DURATION_MS);

const assignmentColumns = db.prepare('PRAGMA table_info(mail_assignments)').all() as Array<{ name: string; pk: number }>;
const assignmentHasSource = assignmentColumns.some((column) => column.name === 'source');
const assignmentHasCompositeKey = assignmentColumns.some((column) => column.name === 'user_id' && column.pk === 1)
  && assignmentColumns.some((column) => column.name === 'account_id' && column.pk === 2);
if (!assignmentHasSource || !assignmentHasCompositeKey) {
  const sourceExpression = assignmentHasSource ? 'source' : "'auto'";
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS idx_mail_assignments_account;
    ALTER TABLE mail_assignments RENAME TO mail_assignments_legacy;
    CREATE TABLE mail_assignments (
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'admin')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, account_id),
      FOREIGN KEY (account_id) REFERENCES managed_mail_accounts(id) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO mail_assignments (user_id, account_id, source, created_at)
      SELECT user_id, account_id, ${sourceExpression}, created_at FROM mail_assignments_legacy;
    DROP TABLE mail_assignments_legacy;
    CREATE INDEX idx_mail_assignments_account ON mail_assignments (account_id);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// Existing paid users receive a fresh 30-day period when this schema upgrade
// is first applied. Administrator access does not depend on subscription time.
db.prepare(`
  UPDATE users
  SET paid_until = ?
  WHERE role = 'user' AND paid = 1 AND paid_until IS NULL
`).run(Date.now() + SUBSCRIPTION_DURATION_MS);

// A pending request is driven by an in-process mailbox polling task. If the
// process starts again, that task no longer exists, so release persisted locks
// instead of leaving the shared mailbox blocked until the old TTL elapses.
const startupTime = Date.now();
db.prepare(`
  UPDATE otp_requests
  SET status = 'expired', error = NULL
  WHERE status = 'pending' AND expires_at <= ?
`).run(startupTime);
db.prepare(`
  UPDATE otp_requests
  SET status = 'failed', error = 'server_restarted'
  WHERE status = 'pending' AND expires_at > ?
`).run(startupTime);

const insertDefaultUser = db.prepare(`
  INSERT OR IGNORE INTO users (id, role, password_hash, paid, paid_until, max_mail_accounts, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insertDefaultUser.run('demo-user', 'user', null, 0, null, 1, Date.now());
// Remove the legacy demonstration administrator from older databases. The
// real administrator is provisioned from ADMIN_USERNAME/ADMIN_PASSWORD.
db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run('demo-admin');
db.prepare("DELETE FROM users WHERE id = ? AND role = 'admin' AND password_hash IS NULL").run('demo-admin');
db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());

function asUser(row: SqlRow): User {
  return {
    id: String(row.id),
    role: row.role === 'admin' ? 'admin' : 'user',
    adminLevel: row.role === 'admin' ? (row.admin_level === 'secondary' ? 'secondary' : 'primary') : undefined,
    adminActive: row.role === 'admin' ? Boolean(row.admin_active) : undefined,
    paid: Boolean(row.paid),
    paidUntil: row.paid_until == null ? undefined : Number(row.paid_until),
    planId: row.subscription_plan_id == null ? undefined : String(row.subscription_plan_id),
    maxMailAccounts: Number(row.max_mail_accounts ?? 1),
    canViewMailCredentials: Boolean(row.can_view_mail_credentials),
    createdAt: Number(row.created_at)
  };
}

function asPaymentOrder(row: SqlRow): PaymentOrder {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planId: String(row.plan_id ?? DEFAULT_PAYMENT_PLAN_ID),
    amountFen: Number(row.amount_fen),
    status: row.status as PaymentOrder['status'],
    paymentMethod: row.payment_method == null ? undefined : String(row.payment_method),
    providerTradeNo: row.provider_trade_no == null ? undefined : String(row.provider_trade_no),
    adminNote: row.admin_note == null ? undefined : String(row.admin_note),
    createdAt: Number(row.created_at),
    paidAt: row.paid_at == null ? undefined : Number(row.paid_at)
  };
}

function asPaymentPlan(row: SqlRow): PaymentPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    seatCount: Number(row.seat_count),
    displaySeatCount: Number(row.display_seat_count ?? row.seat_count),
    amountFen: Number(row.amount_fen),
    durationDays: Number(row.duration_days),
    active: Boolean(row.active),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function asPaymentSettings(row: SqlRow): PaymentSettings {
  return {
    id: String(row.id),
    enabled: Boolean(row.enabled),
    gatewayType: row.gateway_type as PaymentSettings['gatewayType'],
    gatewayUrl: String(row.gateway_url ?? ''),
    callbackBaseUrl: String(row.callback_base_url ?? ''),
    returnUrl: String(row.return_url ?? ''),
    merchantId: String(row.merchant_id ?? ''),
    encryptedMerchantKey: String(row.encrypted_merchant_key ?? ''),
    minAmountFen: Number(row.min_amount_fen ?? 100),
    updatedAt: Number(row.updated_at)
  };
}

function asAnnouncement(row: SqlRow): Announcement {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    active: Boolean(row.active),
    priority: Number(row.priority ?? 0),
    startsAt: Number(row.starts_at),
    expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function asMailConnection(row: SqlRow): MailConnection {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    encryptedAppPassword: String(row.encrypted_app_password),
    provider: row.provider as MailConnection['provider'],
    createdAt: Number(row.created_at)
  };
}

function asManagedAccount(row: SqlRow): ManagedMailAccount {
  return {
    ...asMailConnection(row),
    encryptedLoginPassword: row.encrypted_login_password == null ? undefined : String(row.encrypted_login_password),
    note: String(row.note ?? ''),
    maxUsers: Number(row.max_users),
    active: Boolean(row.active),
    expiresAt: Number(row.expires_at ?? Number(row.created_at) + SUBSCRIPTION_DURATION_MS)
  };
}

function asMailAssignment(row: SqlRow): MailAssignment {
  return {
    userId: String(row.assignment_user_id),
    accountId: String(row.id),
    source: row.assignment_source as MailAssignmentSource,
    createdAt: Number(row.assignment_created_at),
    account: asManagedAccount(row)
  };
}

function asOtpRequest(row: SqlRow): OtpRequest {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    connectionId: String(row.connection_id),
    status: row.status as OtpRequest['status'],
    codeHash: row.code_hash == null ? undefined : String(row.code_hash),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at == null ? undefined : Number(row.consumed_at),
    error: row.error == null ? undefined : String(row.error)
  };
}

function asSupportTicket(row: SqlRow): SupportTicket {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    subject: String(row.subject),
    status: row.status as SupportTicketStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function asSupportMessage(row: SqlRow): SupportMessage {
  const attachment = row.attachment_path == null ? undefined : {
    fileName: String(row.attachment_path),
    originalName: String(row.attachment_name ?? '图片'),
    mimeType: String(row.attachment_mime ?? 'application/octet-stream'),
    size: Number(row.attachment_size ?? 0)
  };
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    senderType: row.sender_type as SupportMessageSender,
    senderId: String(row.sender_id),
    content: String(row.content),
    attachment,
    createdAt: Number(row.created_at)
  };
}

function asSupportAiConfig(row: SqlRow): SupportAiConfig {
  return {
    id: String(row.id),
    baseUrl: String(row.base_url),
    model: String(row.model),
    encryptedApiKey: String(row.encrypted_api_key),
    active: Boolean(row.active),
    updatedAt: Number(row.updated_at)
  };
}

function getRow(sql: string, ...params: (string | number | null)[]): SqlRow | undefined {
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

function allRows(sql: string, ...params: (string | number | null)[]): SqlRow[] {
  return db.prepare(sql).all(...params) as SqlRow[];
}

function expireSubscriptions(): void {
  const now = Date.now();
  db.prepare(`
    DELETE FROM mail_assignments
    WHERE user_id IN (
      SELECT id FROM users
      WHERE role = 'user' AND paid_until IS NOT NULL AND paid_until <= ?
    )
  `).run(now);
  db.prepare(`
    UPDATE users
    SET paid = 0, paid_until = NULL
    WHERE role = 'user' AND paid_until IS NOT NULL AND paid_until <= ?
  `).run(now);
}

export const store = {
  ensureUser(userId: string, paid = false): User {
    const existing = store.getUser(userId);
    if (existing) return existing;
    const now = Date.now();
    const defaultPlan = getRow('SELECT * FROM payment_plans WHERE id = ?', DEFAULT_PAYMENT_PLAN_ID);
    const durationDays = Number(defaultPlan?.duration_days ?? 30);
    const user: User = {
      id: userId,
      role: 'user',
      paid,
      paidUntil: paid ? now + durationDays * 24 * 60 * 60 * 1000 : undefined,
      planId: paid ? DEFAULT_PAYMENT_PLAN_ID : undefined,
      maxMailAccounts: 1,
      canViewMailCredentials: false,
      createdAt: now
    };
    db.prepare('INSERT INTO users (id, role, password_hash, paid, paid_until, subscription_plan_id, max_mail_accounts, can_view_mail_credentials, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.role, null, user.paid ? 1 : 0, user.paidUntil ?? null, user.planId ?? null, user.maxMailAccounts, 0, user.createdAt);
    return user;
  },

  getUserPasswordHash(userId: string): string | undefined {
    const row = getRow('SELECT password_hash FROM users WHERE id = ?', userId);
    return row?.password_hash == null ? undefined : String(row.password_hash);
  },

  createRegisteredUser(userId: string, passwordHash: string): User | undefined {
    if (store.getUser(userId)) return undefined;
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, role, password_hash, paid, paid_until, subscription_plan_id, max_mail_accounts, created_at)
      VALUES (?, 'user', ?, 0, NULL, NULL, 1, ?)
    `).run(userId, passwordHash, now);
    return store.getUser(userId);
  },

  saveUserPasswordHash(userId: string, passwordHash: string): boolean {
    return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId).changes > 0;
  },

  upsertAdminCredentials(userId: string, passwordHash: string): User {
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, role, admin_level, admin_active, password_hash, paid, paid_until, subscription_plan_id, max_mail_accounts, created_at)
      VALUES (?, 'admin', 'primary', 1, ?, 1, NULL, NULL, 1, ?)
      ON CONFLICT(id) DO UPDATE SET role = 'admin', admin_level = 'primary', admin_active = 1, password_hash = excluded.password_hash
    `).run(userId, passwordHash, now);
    return store.getUser(userId)!;
  },

  createSecondaryAdmin(userId: string, passwordHash: string): User | undefined {
    if (store.getUser(userId)) return undefined;
    db.prepare(`
      INSERT INTO users (id, role, admin_level, admin_active, password_hash, paid, paid_until, subscription_plan_id, max_mail_accounts, created_at)
      VALUES (?, 'admin', 'secondary', 1, ?, 1, NULL, NULL, 1, ?)
    `).run(userId, passwordHash, Date.now());
    return store.getUser(userId);
  },

  listAdmins(): User[] {
    return allRows("SELECT * FROM users WHERE role = 'admin' ORDER BY admin_level ASC, created_at ASC").map(asUser);
  },

  setSecondaryAdminActive(userId: string, active: boolean): User | undefined {
    const result = db.prepare("UPDATE users SET admin_active = ? WHERE id = ? AND role = 'admin' AND admin_level = 'secondary'")
      .run(active ? 1 : 0, userId);
    if (result.changes === 0) return undefined;
    if (!active) store.deleteAuthSessionsForUser(userId);
    return store.getUser(userId);
  },

  deleteSecondaryAdmin(userId: string): boolean {
    const current = store.getUser(userId);
    if (!current || current.role !== 'admin' || current.adminLevel !== 'secondary') return false;
    store.deleteAuthSessionsForUser(userId);
    return db.prepare("DELETE FROM users WHERE id = ? AND role = 'admin' AND admin_level = 'secondary'").run(userId).changes > 0;
  },

  createAuthSession(tokenHash: string, userId: string, expiresAt: number): void {
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, expiresAt, Date.now());
  },

  getAuthSessionUser(tokenHash: string): User | undefined {
    const row = getRow(`
      SELECT users.*
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
        AND (users.role <> 'admin' OR users.admin_active = 1)
    `, tokenHash, Date.now());
    return row ? asUser(row) : undefined;
  },

  deleteAuthSession(tokenHash: string): boolean {
    return db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
  },

  deleteAuthSessionsForUser(userId: string): void {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  },

  deleteOtherAuthSessionsForUser(userId: string, currentTokenHash: string): void {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').run(userId, currentTokenHash);
  },

  deleteUser(userId: string): boolean {
    const user = getRow('SELECT id, role FROM users WHERE id = ?', userId);
    if (!user || user.role === 'admin') return false;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Keep managed_mail_accounts intact: those are administrator-owned pool
      // accounts. Only remove this user's bindings and user-owned records.
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM mail_assignments WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM otp_requests WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM mail_connections WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM payment_orders WHERE user_id = ?').run(userId);

      // support_messages are removed by the foreign-key cascade when their
      // user's tickets are deleted.
      db.prepare('DELETE FROM support_tickets WHERE user_id = ?').run(userId);
      const result = db.prepare('DELETE FROM users WHERE id = ? AND role <> \'admin\'').run(userId);
      db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },

  getUser(userId: string): User | undefined {
    expireSubscriptions();
    const row = getRow('SELECT * FROM users WHERE id = ?', userId);
    return row ? asUser(row) : undefined;
  },

  listUsers(): User[] {
    expireSubscriptions();
    return allRows('SELECT * FROM users ORDER BY created_at DESC').map(asUser);
  },

  setPaid(userId: string, paid: boolean, planId?: string): User | undefined {
    const current = store.getUser(userId);
    if (!current) return undefined;
    const now = Date.now();
    const selectedPlanId = planId ?? current.planId ?? DEFAULT_PAYMENT_PLAN_ID;
    const selectedPlan = getRow('SELECT * FROM payment_plans WHERE id = ?', selectedPlanId);
    const durationDays = Number(selectedPlan?.duration_days ?? 30);
    const paidUntil = paid
      ? Math.max(now, current.paidUntil ?? now) + durationDays * 24 * 60 * 60 * 1000
      : null;
    const result = db.prepare('UPDATE users SET paid = ?, paid_until = ?, subscription_plan_id = ? WHERE id = ?')
      .run(paid ? 1 : 0, paidUntil, paid ? selectedPlanId : (current.planId ?? null), userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  pausePaid(userId: string): User | undefined {
    const current = store.getUser(userId);
    if (!current) return undefined;
    const result = db.prepare('UPDATE users SET paid = 0 WHERE id = ?').run(userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  restorePaid(userId: string): User | undefined {
    const current = store.getUser(userId);
    if (!current?.paidUntil || current.paidUntil <= Date.now()) return undefined;
    const result = db.prepare('UPDATE users SET paid = 1 WHERE id = ?').run(userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  setPaidUntil(userId: string, paidUntil: number): User | undefined {
    const result = db.prepare('UPDATE users SET paid_until = ? WHERE id = ?').run(paidUntil, userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  getPaymentPlan(id: string): PaymentPlan | undefined {
    const row = getRow('SELECT * FROM payment_plans WHERE id = ?', id);
    return row ? asPaymentPlan(row) : undefined;
  },

  listPaymentPlans(activeOnly = false): PaymentPlan[] {
    const rows = activeOnly
      ? allRows('SELECT * FROM payment_plans WHERE active = 1 AND deleted = 0 ORDER BY seat_count ASC, amount_fen ASC')
      : allRows('SELECT * FROM payment_plans WHERE deleted = 0 ORDER BY active DESC, seat_count ASC, amount_fen ASC');
    return rows.map(asPaymentPlan);
  },

  savePaymentPlan(plan: PaymentPlan): PaymentPlan {
    db.prepare(`
      INSERT INTO payment_plans
        (id, name, seat_count, display_seat_count, amount_fen, duration_days, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        seat_count = excluded.seat_count,
        display_seat_count = excluded.display_seat_count,
        amount_fen = excluded.amount_fen,
        duration_days = excluded.duration_days,
        active = excluded.active,
        updated_at = excluded.updated_at
    `).run(plan.id, plan.name, plan.seatCount, plan.displaySeatCount, plan.amountFen, plan.durationDays, plan.active ? 1 : 0, plan.createdAt, plan.updatedAt);
    return plan;
  },

  updatePaymentPlan(id: string, patch: Partial<PaymentPlan>): PaymentPlan | undefined {
    const current = store.getPaymentPlan(id);
    if (!current) return undefined;
    return store.savePaymentPlan({ ...current, ...patch, updatedAt: Date.now() });
  },

  deletePaymentPlan(id: string): boolean {
    // Soft-delete the plan so historic orders and existing subscriptions can
    // continue resolving their original plan information.
    const result = db.prepare('UPDATE payment_plans SET active = 0, deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0')
      .run(Date.now(), id);
    return result.changes > 0;
  },

  getPaymentSettings(): PaymentSettings {
    const row = getRow('SELECT * FROM payment_settings WHERE id = ?', 'default');
    if (row) return asPaymentSettings(row);
    const now = Date.now();
    const settings: PaymentSettings = { id: 'default', enabled: false, gatewayType: 'epay', gatewayUrl: '', callbackBaseUrl: '', returnUrl: '', merchantId: '', encryptedMerchantKey: '', minAmountFen: 100, updatedAt: now };
    store.savePaymentSettings(settings);
    return settings;
  },

  savePaymentSettings(settings: PaymentSettings): PaymentSettings {
    db.prepare(`
      INSERT INTO payment_settings
        (id, enabled, gateway_type, gateway_url, callback_base_url, return_url, merchant_id, encrypted_merchant_key, min_amount_fen, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        gateway_type = excluded.gateway_type,
        gateway_url = excluded.gateway_url,
        callback_base_url = excluded.callback_base_url,
        return_url = excluded.return_url,
        merchant_id = excluded.merchant_id,
        encrypted_merchant_key = excluded.encrypted_merchant_key,
        min_amount_fen = excluded.min_amount_fen,
        updated_at = excluded.updated_at
    `).run(settings.id, settings.enabled ? 1 : 0, settings.gatewayType, settings.gatewayUrl, settings.callbackBaseUrl, settings.returnUrl, settings.merchantId, settings.encryptedMerchantKey, settings.minAmountFen, settings.updatedAt);
    return settings;
  },

  saveAnnouncement(announcement: Announcement): Announcement {
    db.prepare(`
      INSERT INTO announcements (id, title, content, active, priority, starts_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        active = excluded.active,
        priority = excluded.priority,
        starts_at = excluded.starts_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(announcement.id, announcement.title, announcement.content, announcement.active ? 1 : 0, announcement.priority, announcement.startsAt, announcement.expiresAt ?? null, announcement.createdAt, announcement.updatedAt);
    return announcement;
  },

  getAnnouncement(id: string): Announcement | undefined {
    const row = getRow('SELECT * FROM announcements WHERE id = ?', id);
    return row ? asAnnouncement(row) : undefined;
  },

  listAnnouncements(): Announcement[] {
    return allRows('SELECT * FROM announcements ORDER BY active DESC, priority DESC, starts_at DESC, created_at DESC').map(asAnnouncement);
  },

  listActiveAnnouncements(now = Date.now()): Announcement[] {
    return allRows(`
      SELECT * FROM announcements
      WHERE active = 1 AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY priority DESC, starts_at DESC, created_at DESC
    `, now, now).map(asAnnouncement);
  },

  updateAnnouncement(id: string, patch: Partial<Announcement>): Announcement | undefined {
    const current = store.getAnnouncement(id);
    if (!current) return undefined;
    return store.saveAnnouncement({ ...current, ...patch, updatedAt: Date.now() });
  },

  deleteAnnouncement(id: string): boolean {
    const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    return result.changes > 0;
  },

  setMaxMailAccounts(userId: string, maxMailAccounts: number): User | undefined {
    const result = db.prepare('UPDATE users SET max_mail_accounts = ? WHERE id = ?')
      .run(maxMailAccounts, userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  setCanViewMailCredentials(userId: string, enabled: boolean): User | undefined {
    const result = db.prepare('UPDATE users SET can_view_mail_credentials = ? WHERE id = ?')
      .run(enabled ? 1 : 0, userId);
    return result.changes > 0 ? store.getUser(userId) : undefined;
  },

  savePaymentOrder(order: PaymentOrder): PaymentOrder {
    db.prepare(`
      INSERT INTO payment_orders (id, user_id, plan_id, amount_fen, status, payment_method, provider_trade_no, admin_note, created_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        plan_id = excluded.plan_id,
        amount_fen = excluded.amount_fen,
        status = excluded.status,
        payment_method = excluded.payment_method,
        provider_trade_no = excluded.provider_trade_no,
        admin_note = excluded.admin_note,
        created_at = excluded.created_at,
        paid_at = excluded.paid_at
    `).run(order.id, order.userId, order.planId, order.amountFen, order.status, order.paymentMethod ?? null, order.providerTradeNo ?? null, order.adminNote ?? null, order.createdAt, order.paidAt ?? null);
    return order;
  },

  getPaymentOrder(id: string): PaymentOrder | undefined {
    const row = getRow('SELECT * FROM payment_orders WHERE id = ?', id);
    return row ? asPaymentOrder(row) : undefined;
  },

  updatePaymentOrder(id: string, patch: Partial<PaymentOrder>): PaymentOrder | undefined {
    const current = store.getPaymentOrder(id);
    if (!current) return undefined;
    return store.savePaymentOrder({ ...current, ...patch });
  },

  markPaymentOrderPaid(id: string, paidAt: number, providerTradeNo?: string, paymentMethod?: string): PaymentOrder | undefined {
    const result = db.prepare(`
      UPDATE payment_orders
      SET status = 'paid',
          provider_trade_no = COALESCE(?, provider_trade_no),
          payment_method = COALESCE(?, payment_method),
          paid_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(providerTradeNo ?? null, paymentMethod ?? null, paidAt, id);
    if (result.changes === 0) return undefined;
    return store.getPaymentOrder(id);
  },

  listPaymentOrdersForUser(userId: string): PaymentOrder[] {
    return allRows('SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC', userId)
      .map(asPaymentOrder);
  },

  listPaymentOrders(): PaymentOrder[] {
    return allRows('SELECT * FROM payment_orders ORDER BY created_at DESC').map(asPaymentOrder);
  },

  saveConnection(connection: MailConnection): MailConnection {
    db.prepare('DELETE FROM mail_connections WHERE user_id = ? AND id <> ?').run(connection.userId, connection.id);
    db.prepare(`
      INSERT INTO mail_connections (id, user_id, email, encrypted_app_password, provider, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        email = excluded.email,
        encrypted_app_password = excluded.encrypted_app_password,
        provider = excluded.provider,
        created_at = excluded.created_at
    `).run(connection.id, connection.userId, connection.email, connection.encryptedAppPassword, connection.provider, connection.createdAt);
    return connection;
  },

  getConnectionForUser(userId: string, accountId?: string): MailConnection | undefined {
    const managedRow = accountId ? getRow(`
      SELECT account.*
      FROM mail_assignments assignment
      JOIN managed_mail_accounts account ON account.id = assignment.account_id
      WHERE assignment.user_id = ? AND account.id = ? AND account.active = 1
    `, userId, accountId) : getRow(`
      SELECT account.*
      FROM mail_assignments assignment
      JOIN managed_mail_accounts account ON account.id = assignment.account_id
      WHERE assignment.user_id = ? AND account.active = 1
      ORDER BY assignment.created_at ASC
      LIMIT 1
    `, userId);
    if (managedRow) return asManagedAccount(managedRow);
    const row = getRow('SELECT * FROM mail_connections WHERE user_id = ?', userId);
    return row ? asMailConnection(row) : undefined;
  },

  saveManagedAccount(account: ManagedMailAccount): ManagedMailAccount {
    db.prepare(`
      INSERT INTO managed_mail_accounts
        (id, user_id, email, encrypted_app_password, encrypted_login_password, provider, note, max_users, active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        email = excluded.email,
        encrypted_app_password = excluded.encrypted_app_password,
        encrypted_login_password = excluded.encrypted_login_password,
        provider = excluded.provider,
        note = excluded.note,
        max_users = excluded.max_users,
        active = excluded.active,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(
      account.id,
      account.userId,
      account.email,
      account.encryptedAppPassword,
      account.encryptedLoginPassword ?? null,
      account.provider,
      account.note,
      account.maxUsers,
      account.active ? 1 : 0,
      account.expiresAt,
      account.createdAt
    );
    return account;
  },

  getManagedAccount(id: string): ManagedMailAccount | undefined {
    const row = getRow('SELECT * FROM managed_mail_accounts WHERE id = ?', id);
    return row ? asManagedAccount(row) : undefined;
  },

  getManagedAccountByEmail(email: string): ManagedMailAccount | undefined {
    const row = getRow('SELECT * FROM managed_mail_accounts WHERE email = ?', email.toLowerCase());
    return row ? asManagedAccount(row) : undefined;
  },

  listManagedAccounts(): ManagedMailAccount[] {
    return allRows('SELECT * FROM managed_mail_accounts ORDER BY created_at ASC').map(asManagedAccount);
  },

  updateManagedAccount(id: string, patch: Partial<ManagedMailAccount>): ManagedMailAccount | undefined {
    const current = store.getManagedAccount(id);
    if (!current) return undefined;
    return store.saveManagedAccount({ ...current, ...patch });
  },

  deleteManagedAccount(id: string): boolean {
    const result = db.prepare('DELETE FROM managed_mail_accounts WHERE id = ?').run(id);
    return result.changes > 0;
  },

  getAssignedAccountForUser(userId: string): ManagedMailAccount | undefined {
    return store.listAssignmentsForUser(userId)[0]?.account;
  },

  listAssignmentsForUser(userId: string): MailAssignment[] {
    return allRows(`
      SELECT
        account.*,
        assignment.user_id AS assignment_user_id,
        assignment.source AS assignment_source,
        assignment.created_at AS assignment_created_at
      FROM mail_assignments assignment
      JOIN managed_mail_accounts account ON account.id = assignment.account_id
      WHERE assignment.user_id = ?
      ORDER BY assignment.created_at ASC
    `, userId).map(asMailAssignment);
  },

  countUserAssignments(userId: string): number {
    const row = getRow('SELECT COUNT(*) AS total FROM mail_assignments WHERE user_id = ?', userId);
    return Number(row?.total ?? 0);
  },

  isAssignedToUser(userId: string, accountId: string): boolean {
    return Boolean(getRow('SELECT 1 AS found FROM mail_assignments WHERE user_id = ? AND account_id = ?', userId, accountId));
  },

  countAssignments(accountId: string): number {
    const row = getRow('SELECT COUNT(*) AS total FROM mail_assignments WHERE account_id = ?', accountId);
    return Number(row?.total ?? 0);
  },

  assignAccountToUser(userId: string, accountId: string, source: MailAssignmentSource): ManagedMailAccount | undefined {
    expireSubscriptions();
    const user = store.getUser(userId);
    const account = store.getManagedAccount(accountId);
    if (!user?.paid || !account?.active) return undefined;
    if (store.isAssignedToUser(userId, accountId)) return account;
    if (store.countUserAssignments(userId) >= user.maxMailAccounts) return undefined;
    if (store.countAssignments(accountId) >= account.maxUsers) return undefined;
    db.prepare(`
      INSERT INTO mail_assignments (user_id, account_id, source, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, accountId, source, Date.now());
    return account;
  },

  assignAvailableAccount(userId: string, minimumUsers = 1): ManagedMailAccount | undefined {
    expireSubscriptions();
    const user = store.getUser(userId);
    if (!user?.paid || store.countUserAssignments(userId) >= user.maxMailAccounts) return undefined;
    const candidateRow = getRow(`
      SELECT account.*, COUNT(assignment.user_id) AS assignment_count
      FROM managed_mail_accounts account
      LEFT JOIN mail_assignments assignment ON assignment.account_id = account.id
      WHERE account.active = 1
        AND account.max_users >= ?
        AND NOT EXISTS (
          SELECT 1 FROM mail_assignments own_assignment
          WHERE own_assignment.user_id = ? AND own_assignment.account_id = account.id
        )
      GROUP BY account.id
      HAVING COUNT(assignment.user_id) < account.max_users
      ORDER BY RANDOM()
      LIMIT 1
    `, minimumUsers, userId);
    if (!candidateRow) return undefined;
    const candidate = asManagedAccount(candidateRow);
    return store.assignAccountToUser(userId, candidate.id, 'auto');
  },

  unassignUser(userId: string): void {
    db.prepare('DELETE FROM mail_assignments WHERE user_id = ?').run(userId);
  },

  unassignAccountFromUser(userId: string, accountId: string): boolean {
    const result = db.prepare('DELETE FROM mail_assignments WHERE user_id = ? AND account_id = ?')
      .run(userId, accountId);
    return result.changes > 0;
  },

  saveRequest(request: OtpRequest): OtpRequest {
    db.prepare(`
      INSERT INTO otp_requests
        (id, user_id, connection_id, status, code_hash, created_at, expires_at, consumed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        connection_id = excluded.connection_id,
        status = excluded.status,
        code_hash = excluded.code_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        consumed_at = excluded.consumed_at,
        error = excluded.error
    `).run(
      request.id,
      request.userId,
      request.connectionId,
      request.status,
      request.codeHash ?? null,
      request.createdAt,
      request.expiresAt,
      request.consumedAt ?? null,
      request.error ?? null
    );
    return request;
  },

  getRequest(id: string): OtpRequest | undefined {
    const row = getRow('SELECT * FROM otp_requests WHERE id = ?', id);
    return row ? asOtpRequest(row) : undefined;
  },

  updateRequest(id: string, patch: Partial<OtpRequest>): OtpRequest | undefined {
    const current = store.getRequest(id);
    if (!current) return undefined;
    return store.saveRequest({ ...current, ...patch });
  },

  listRequests(): OtpRequest[] {
    return allRows('SELECT * FROM otp_requests ORDER BY created_at DESC').map(asOtpRequest);
  },

  getPendingRequestForConnection(connectionId: string): OtpRequest | undefined {
    const row = getRow(`
      SELECT *
      FROM otp_requests
      WHERE connection_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `, connectionId, Date.now());
    return row ? asOtpRequest(row) : undefined;
  },

  hasPendingRequestForConnection(connectionId: string): boolean {
    return Boolean(store.getPendingRequestForConnection(connectionId));
  },

  saveSupportTicket(ticket: SupportTicket): SupportTicket {
    db.prepare(`
      INSERT INTO support_tickets (id, user_id, subject, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        subject = excluded.subject,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(ticket.id, ticket.userId, ticket.subject, ticket.status, ticket.createdAt, ticket.updatedAt);
    return ticket;
  },

  getSupportTicket(id: string): SupportTicket | undefined {
    const row = getRow('SELECT * FROM support_tickets WHERE id = ?', id);
    return row ? asSupportTicket(row) : undefined;
  },

  listSupportTickets(userId?: string): SupportTicket[] {
    const rows = userId
      ? allRows('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC', userId)
      : allRows('SELECT * FROM support_tickets ORDER BY updated_at DESC');
    return rows.map(asSupportTicket);
  },

  updateSupportTicket(id: string, patch: Partial<SupportTicket>): SupportTicket | undefined {
    const current = store.getSupportTicket(id);
    if (!current) return undefined;
    return store.saveSupportTicket({ ...current, ...patch, updatedAt: Date.now() });
  },

  deleteSupportTicket(id: string): boolean {
    const result = db.prepare('DELETE FROM support_tickets WHERE id = ?').run(id);
    return result.changes > 0;
  },

  saveSupportMessage(message: SupportMessage): SupportMessage {
    db.prepare(`
      INSERT INTO support_messages
        (id, ticket_id, sender_type, sender_id, content, attachment_path, attachment_name, attachment_mime, attachment_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.ticketId,
      message.senderType,
      message.senderId,
      message.content,
      message.attachment?.fileName ?? null,
      message.attachment?.originalName ?? null,
      message.attachment?.mimeType ?? null,
      message.attachment?.size ?? null,
      message.createdAt
    );
    db.prepare('UPDATE support_tickets SET updated_at = ? WHERE id = ?').run(message.createdAt, message.ticketId);
    return message;
  },

  updateSupportMessage(id: string, patch: Partial<SupportMessage>): SupportMessage | undefined {
    const currentRow = getRow('SELECT * FROM support_messages WHERE id = ?', id);
    if (!currentRow) return undefined;
    const current = asSupportMessage(currentRow);
    const next = { ...current, ...patch };
    db.prepare(`
      UPDATE support_messages
      SET content = ?, attachment_path = ?, attachment_name = ?, attachment_mime = ?, attachment_size = ?, created_at = ?
      WHERE id = ?
    `).run(
      next.content,
      next.attachment?.fileName ?? null,
      next.attachment?.originalName ?? null,
      next.attachment?.mimeType ?? null,
      next.attachment?.size ?? null,
      next.createdAt,
      id
    );
    return next;
  },

  listSupportMessages(ticketId: string): SupportMessage[] {
    return allRows('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC', ticketId).map(asSupportMessage);
  },

  getSupportMessageByAttachment(fileName: string): SupportMessage | undefined {
    const row = getRow('SELECT * FROM support_messages WHERE attachment_path = ?', fileName);
    return row ? asSupportMessage(row) : undefined;
  },

  getSupportAiConfig(): SupportAiConfig | undefined {
    const row = getRow('SELECT * FROM support_ai_configs WHERE id = ?', 'default');
    return row ? asSupportAiConfig(row) : undefined;
  },

  saveSupportAiConfig(configValue: SupportAiConfig): SupportAiConfig {
    db.prepare(`
      INSERT INTO support_ai_configs (id, base_url, model, encrypted_api_key, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        model = excluded.model,
        encrypted_api_key = excluded.encrypted_api_key,
        active = excluded.active,
        updated_at = excluded.updated_at
    `).run(configValue.id, configValue.baseUrl, configValue.model, configValue.encryptedApiKey, configValue.active ? 1 : 0, configValue.updatedAt);
    return configValue;
  }
};
