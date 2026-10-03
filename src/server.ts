import express, { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { sessionIdentity, requireAdmin, requirePaidUser, requirePrimaryAdmin, requireUser } from './auth.js';
import { config } from './config.js';
import { decryptSecret, encryptSecret, hashCode, hashPassword, hashSessionToken, randomId, randomSessionToken, verifyPassword } from './crypto.js';
import { findLatestOtp, providerForEmail, waitForOtp } from './netease-mail.js';
import { store } from './store.js';
import { MailAssignment, ManagedMailAccount, OtpRequest, PaymentPlan, PaymentSettings } from './types.js';

const app = express();
const otpControllers = new Map<string, AbortController>();
const managedAccountTests = new Map<string, { digest: string; expiresAt: number }>();
const MANAGED_ACCOUNT_TEST_TTL_MS = 10 * 60 * 1000;
const SUPPORT_UPLOAD_DIR = path.resolve(process.cwd(), 'data/support-uploads');
fs.mkdirSync(SUPPORT_UPLOAD_DIR, { recursive: true });
const supportUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, SUPPORT_UPLOAD_DIR),
    filename: (_req, file, callback) => callback(null, `${randomId()}${path.extname(file.originalname).toLowerCase() || '.img'}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      callback(new Error('仅支持 JPG、PNG、GIF、WebP 图片'));
      return;
    }
    callback(null, true);
  }
});
function handleSupportUpload(req: Request, res: Response, next: NextFunction): void {
  supportUpload.single('image')(req, res, (error) => {
    if (error) {
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? '图片不能超过 5MB'
        : '仅支持 JPG、PNG、GIF、WebP 图片';
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(sessionIdentity);

const publicDir = path.join(process.cwd(), 'public');
// Let the authenticated root route below decide whether the visitor belongs
// on the user page or the administrator home. Other static files still load
// normally; only the directory index is disabled here.
app.use(express.static(publicDir, { index: false }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  if (req.role === 'admin') return res.redirect('/admin-users.html');
  return res.sendFile(path.join(publicDir, 'index.html'));
});

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hasChinese = (value: string) => /[\u3400-\u9fff]/u.test(value);
const numericAccount = /^\d{8,64}$/;
const asciiEmailAccount = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const accountSchema = z.string().trim().superRefine((value, context) => {
  if (value.length < 8 || value.length > 128 || hasChinese(value) || (!numericAccount.test(value) && !asciiEmailAccount.test(value))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '账号必须是至少 8 位的阿拉伯数字或邮箱地址，不能包含中文' });
  }
});
const adminAccountSchema = z.string().trim().min(4, '管理员账号至少 4 位').max(64, '管理员账号不能超过 64 位')
  .regex(/^[A-Za-z0-9_.@-]+$/, '管理员账号只能使用英文、数字、点、下划线、@ 或短横线');
const passwordSchema = z.string().superRefine((value, context) => {
  if (value.length < 8 || value.length > 128 || hasChinese(value) || !/^[\x21-\x7E]+$/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '密码至少 8 位，只能使用区分大小写的英文、数字或符号，不能包含中文和空格' });
  }
});

store.upsertAdminCredentials(config.ADMIN_USERNAME, hashPassword(config.ADMIN_PASSWORD));

function authUserView(user: import('./types.js').User) {
  const primaryAdmin = user.role === 'admin' && user.adminLevel === 'primary';
  return {
    id: user.id,
    role: user.role,
    adminLevel: user.adminLevel,
    adminActive: user.adminActive,
    paid: user.paid,
    paidUntil: user.paidUntil,
    maxMailAccounts: user.maxMailAccounts,
    canViewMailCredentials: user.canViewMailCredentials,
    permissions: user.role === 'admin' ? {
      manageAdmins: primaryAdmin,
      manageSubscriptions: primaryAdmin,
      manageBilling: primaryAdmin
    } : undefined
  };
}

function createLoginSession(userId: string, rememberMe = false) {
  const token = randomSessionToken();
  const expiresAt = Date.now() + (rememberMe ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS);
  store.createAuthSession(hashSessionToken(token), userId, expiresAt);
  return { token, expiresAt };
}

app.post('/api/auth/register', (req, res) => {
  const parsed = z.object({ account: accountSchema, password: passwordSchema, confirmPassword: z.string(), rememberMe: z.boolean().default(false) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '注册信息格式不正确' });
  if (parsed.data.password !== parsed.data.confirmPassword) return res.status(400).json({ error: '两次输入的密码不一致' });
  const user = store.createRegisteredUser(parsed.data.account, hashPassword(parsed.data.password));
  if (!user) return res.status(409).json({ error: '该账号已经注册，请直接登录' });
  const session = createLoginSession(user.id, parsed.data.rememberMe);
  return res.status(201).json({ ...session, user: authUserView(user) });
});

app.post('/api/auth/login', (req, res) => {
  const parsed = z.object({ account: z.string().trim().min(1).max(128), password: z.string().min(1).max(128), rememberMe: z.boolean().default(false) }).safeParse(req.body ?? {});
  if (!parsed.success || hasChinese(parsed.data.account) || hasChinese(parsed.data.password)) return res.status(400).json({ error: '账号或密码格式不正确，不能包含中文' });
  const user = store.getUser(parsed.data.account);
  const storedHash = user ? store.getUserPasswordHash(user.id) : undefined;
  if (!user || !storedHash || !verifyPassword(parsed.data.password, storedHash)) return res.status(401).json({ error: '账号或密码错误，请注意区分大小写' });
  if (user.role === 'admin' && user.adminActive === false) return res.status(403).json({ error: '该次级管理员账号已被停用' });
  const session = createLoginSession(user.id, parsed.data.rememberMe);
  return res.json({ ...session, user: authUserView(user) });
});

app.get('/api/auth/me', requireUser, (req, res) => {
  const user = store.getUser(req.userId!);
  return user ? res.json({ user: authUserView(user) }) : res.status(401).json({ error: '登录状态已失效' });
});

app.patch('/api/auth/password', requireUser, (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(128),
    password: passwordSchema,
    confirmPassword: z.string().max(128)
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '密码格式不正确' });
  if (parsed.data.password !== parsed.data.confirmPassword) return res.status(400).json({ error: '两次输入的新密码不一致' });
  if (parsed.data.currentPassword === parsed.data.password) return res.status(400).json({ error: '新密码不能与当前密码相同' });

  const currentHash = store.getUserPasswordHash(req.userId!);
  if (!currentHash || !verifyPassword(parsed.data.currentPassword, currentHash)) {
    return res.status(403).json({ error: '当前密码不正确，密码未修改' });
  }
  if (!store.saveUserPasswordHash(req.userId!, hashPassword(parsed.data.password))) {
    return res.status(404).json({ error: '用户不存在，密码未修改' });
  }
  const authorization = req.header('authorization') ?? '';
  const currentToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (currentToken) store.deleteOtherAuthSessionsForUser(req.userId!, hashSessionToken(currentToken));
  return res.json({ ok: true });
});

app.post('/api/auth/logout', requireUser, (req, res) => {
  const authorization = req.header('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (token) store.deleteAuthSession(hashSessionToken(token));
  return res.json({ ok: true });
});

app.get('/api/announcements', (_req, res) => {
  return res.json({ announcements: store.listActiveAnnouncements() });
});

function assignmentView(assignment: MailAssignment) {
  return {
    id: assignment.account.id,
    email: assignment.account.email,
    provider: assignment.account.provider,
    active: assignment.account.active,
    source: assignment.source,
    assignedAt: assignment.createdAt
  };
}

function mailCredentialView(account: ManagedMailAccount) {
  if (!account.encryptedLoginPassword) return undefined;
  return {
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    username: account.email,
    password: decryptSecret(account.encryptedLoginPassword),
    label: '邮箱登录密码'
  };
}

function planView(plan: PaymentPlan) {
  return {
    id: plan.id,
    name: plan.name,
    seatCount: plan.seatCount,
    displaySeatCount: plan.displaySeatCount,
    amountFen: plan.amountFen,
    durationDays: plan.durationDays,
    active: plan.active
  };
}

function paymentOrderView(order: import('./types.js').PaymentOrder) {
  const plan = store.getPaymentPlan(order.planId);
  return {
    ...order,
    planName: plan?.name ?? '套餐已删除',
    planDurationDays: plan?.durationDays,
    planSeatCount: plan?.displaySeatCount
  };
}

function epayBaseUrl(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/submit(?:\.php)?$/i, '');
}

function epaySign(params: Record<string, string>, merchantKey: string): string {
  const raw = Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return crypto.createHash('md5').update(`${raw}${merchantKey}`, 'utf8').digest('hex');
}

function activatePaidOrder(order: import('./types.js').PaymentOrder) {
  const plan = store.getPaymentPlan(order.planId);
  if (!plan) return undefined;
  const paidOrder = store.updatePaymentOrder(order.id, { status: 'paid', paidAt: order.paidAt ?? Date.now() });
  const user = store.setPaid(order.userId, true, plan.id);
  if (user?.paid && store.countUserAssignments(order.userId) === 0) store.assignAvailableAccount(order.userId, plan.seatCount);
  return paidOrder;
}

function paymentSettingsView(settings: PaymentSettings) {
  return {
    enabled: settings.enabled,
    gatewayType: settings.gatewayType,
    gatewayUrl: settings.gatewayUrl,
    callbackBaseUrl: settings.callbackBaseUrl,
    returnUrl: settings.returnUrl,
    merchantId: settings.merchantId,
    minAmountFen: settings.minAmountFen,
    hasMerchantKey: Boolean(settings.encryptedMerchantKey),
    updatedAt: settings.updatedAt
  };
}

function supportTicketView(ticket: import('./types.js').SupportTicket) {
  return {
    id: ticket.id,
    userId: ticket.userId,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    messages: store.listSupportMessages(ticket.id).map((message) => ({
      ...message,
      attachment: message.attachment ? {
        ...message.attachment,
        url: `/api/support/attachments/${encodeURIComponent(message.attachment.fileName)}`
      } : undefined
    }))
  };
}

function supportAttachmentFromRequest(req: Request) {
  if (!req.file) return undefined;
  return {
    fileName: req.file.filename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size
  };
}

function removeUploadedFile(req: Request): void {
  if (req.file?.path) {
    try { fs.unlinkSync(req.file.path); } catch { /* best effort cleanup */ }
  }
}

function parseSupportContent(req: Request): { content: string } | undefined {
  const raw = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (raw.length > 3000) return undefined;
  return { content: raw };
}

function supportAiConfigView(configValue: import('./types.js').SupportAiConfig | undefined) {
  if (!configValue) return { configured: false, baseUrl: '', model: '', active: false, hasApiKey: false };
  return { configured: true, baseUrl: configValue.baseUrl, model: configValue.model, active: configValue.active, hasApiKey: true, updatedAt: configValue.updatedAt };
}

const SUPPORT_AI_WAITING_REPLY = '这个问题需要管理员进一步核实，请稍等一下，管理员会继续帮你处理。';
const SUPPORT_AI_PROCESSING_REPLY = '客服正在处理中，请稍等…';

function supportAiMessages(ticketId: string) {
  return store.listSupportMessages(ticketId).filter((message) => message.senderId !== 'ai-pending').map((message) => ({
    role: message.senderType === 'user' ? 'user' : 'assistant',
    content: message.content
  }));
}

async function requestSupportAiReply(ticket: import('./types.js').SupportTicket): Promise<{ reply: string; resolved: boolean }> {
  const aiConfig = store.getSupportAiConfig();
  if (!aiConfig?.active) return { reply: '', resolved: false };
  const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decryptSecret(aiConfig.encryptedApiKey)}` },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: 'system',
          content: '你是邮箱验证码网关的自动客服，只负责文字回复，不能执行任何后台操作，也不能承诺修改账号、恢复订阅、删除数据或分配邮箱。根据对话判断能否直接解释或指导用户。必须只返回 JSON，格式为 {"canAnswer":true,"reply":"简洁中文回复"}。如果问题需要管理员权限、需要核实数据、涉及退款/订阅恢复/账号变更，或你没有把握，返回 {"canAnswer":false,"reply":""}。'
        },
        ...supportAiMessages(ticket.id)
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `第三方模型请求失败（${response.status}）`);
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  if (!raw) throw new Error('第三方模型未返回有效回复');
  try {
    const parsed = JSON.parse(raw) as { canAnswer?: boolean; reply?: string };
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (parsed.canAnswer === true && reply) return { reply, resolved: true };
    return { reply: SUPPORT_AI_WAITING_REPLY, resolved: false };
  } catch {
    // Compatibility fallback for gateways that ignore response_format. This
    // is still text-only and never triggers an operation.
    return { reply: raw, resolved: true };
  }
}

function queueAutomaticSupportReply(ticket: import('./types.js').SupportTicket): void {
  const aiConfig = store.getSupportAiConfig();
  if (!aiConfig?.active) return;
  const pending = store.saveSupportMessage({ id: randomId(), ticketId: ticket.id, senderType: 'ai', senderId: 'ai-pending', content: SUPPORT_AI_PROCESSING_REPLY, createdAt: Date.now() });
  void requestSupportAiReply(ticket)
    .then((result) => {
      store.updateSupportMessage(pending.id, { content: result.reply });
      store.updateSupportTicket(ticket.id, { status: result.resolved ? 'pending' : 'open' });
    })
    .catch(() => {
      store.updateSupportMessage(pending.id, { content: SUPPORT_AI_WAITING_REPLY });
      store.updateSupportTicket(ticket.id, { status: 'open' });
    });
}

// Real payment flow: the provider creates the payment page, then notifies this server.
app.get('/api/payment/me', requireUser, (req, res) => {
  const user = store.getUser(req.userId!);
  const hasActiveSubscription = Boolean(user?.paidUntil && user.paidUntil > Date.now());
  const storedAssignments = user ? store.listAssignmentsForUser(req.userId!) : [];
  const assignments = user?.paid ? storedAssignments : [];
  const assignment = assignments[0];
  const currentPlan = hasActiveSubscription && user?.planId ? store.getPaymentPlan(user.planId) : undefined;
  return res.json({
    paid: user?.paid === true,
    paused: user?.paid === false && hasActiveSubscription,
    subscriptionLocked: hasActiveSubscription,
    paidUntil: user?.paidUntil,
    currentPlan: currentPlan ? planView(currentPlan) : null,
    maxMailAccounts: user?.maxMailAccounts ?? 1,
    canViewMailCredentials: user?.canViewMailCredentials === true,
    assignments: assignments.map(assignmentView),
    reservedAssignmentsCount: storedAssignments.length,
    assignment: assignment ? assignmentView(assignment) : null,
    assignmentPending: user?.paid === true && assignments.length === 0,
    paymentConfigured: store.getPaymentSettings().enabled,
    paymentMinAmountFen: store.getPaymentSettings().minAmountFen,
    orders: store.listPaymentOrdersForUser(req.userId!)
  });
});

app.get('/api/payment/plans', requireUser, (_req, res) => {
  const user = store.getUser(_req.userId!);
  const hasActiveSubscription = Boolean(user?.paidUntil && user.paidUntil > Date.now());
  if (hasActiveSubscription && user?.planId) {
    const currentPlan = store.getPaymentPlan(user.planId);
    return res.json({ plans: currentPlan ? [planView(currentPlan)] : [], subscriptionLocked: true });
  }
  return res.json({ plans: store.listPaymentPlans(true).map(planView), subscriptionLocked: false });
});

app.post('/api/payment/orders', requireUser, (req, res) => {
  const settings = store.getPaymentSettings();
  if (!settings.enabled || settings.gatewayType !== 'epay') return res.status(409).json({ error: '在线支付尚未启用，请联系管理员' });
  if (!settings.gatewayUrl || !settings.callbackBaseUrl || !settings.merchantId || !settings.encryptedMerchantKey) return res.status(409).json({ error: '支付接口配置不完整，请联系管理员' });
  const user = store.getUser(req.userId!);
  if (user?.paidUntil && user.paidUntil > Date.now()) {
    return res.status(409).json({ error: `当前套餐尚未到期（${new Date(user.paidUntil).toLocaleString('zh-CN')}），到期后才能订购其他套餐` });
  }
  const pendingOrder = store.listPaymentOrdersForUser(req.userId!).find((order) => order.status === 'pending');
  if (pendingOrder) return res.status(409).json({ error: '你已有一笔待支付订单，请先完成或联系管理员关闭后再创建新订单' });
  const parsed = z.object({ planId: z.string().min(1).optional(), amountFen: z.number().int().positive().max(1_000_000).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '套餐参数格式不正确' });
  const plan = parsed.data.planId
    ? store.getPaymentPlan(parsed.data.planId)
    : store.listPaymentPlans(true)[0];
  if (!plan || !plan.active) return res.status(409).json({ error: '套餐不存在或已停用' });
  const amount = (plan.amountFen / 100).toFixed(2);
  if (plan.amountFen < settings.minAmountFen) return res.status(409).json({ error: `该套餐金额低于支付接口最低金额 ¥${(settings.minAmountFen / 100).toFixed(2)}` });
  const orderId = `${Date.now()}${crypto.randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
  const notifyUrl = `${settings.callbackBaseUrl.replace(/\/+$/, '')}/api/payment/epay/notify`;
  const returnUrl = settings.returnUrl || `${settings.callbackBaseUrl.replace(/\/+$/, '')}/`;
  const epayParams: Record<string, string> = {
    pid: settings.merchantId,
    type: 'alipay',
    out_trade_no: orderId,
    notify_url: notifyUrl,
    return_url: returnUrl,
    name: plan.name,
    money: amount,
    sign_type: 'MD5'
  };
  const sign = epaySign(epayParams, decryptSecret(settings.encryptedMerchantKey));
  const order = store.savePaymentOrder({
    id: orderId,
    userId: req.userId!,
    planId: plan.id,
    amountFen: plan.amountFen,
    status: 'pending',
    paymentMethod: 'epay-alipay',
    createdAt: Date.now()
  });
  return res.status(201).json({ order, paymentUrl: `${epayBaseUrl(settings.gatewayUrl)}/submit.php?${new URLSearchParams({ ...epayParams, sign }).toString()}` });
});

app.post('/api/payment/mock/orders', requireUser, (req, res) => {
  return res.status(410).json({ error: '模拟支付已停用，请使用真实支付' });
});

async function handleEpayNotify(req: Request, res: Response) {
  const settings = store.getPaymentSettings();
  if (!settings.enabled || settings.gatewayType !== 'epay' || !settings.encryptedMerchantKey) return res.status(503).send('fail');
  const source = req.method === 'POST' ? req.body : req.query;
  const query: Record<string, string> = Object.fromEntries(Object.entries(source ?? {}).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')]));
  const orderId = query.out_trade_no;
  const order = orderId ? store.getPaymentOrder(orderId) : undefined;
  if (!order || query.pid !== settings.merchantId) return res.status(400).send('fail');
  const expected = epaySign(query, decryptSecret(settings.encryptedMerchantKey));
  if (!query.sign || query.sign.toLowerCase() !== expected.toLowerCase()) return res.status(400).send('fail');
  if (query.trade_status !== 'TRADE_SUCCESS' && query.trade_status !== 'TRADE_FINISHED') return res.send('success');
  const receivedMoney = Number(query.money);
  if (!Number.isFinite(receivedMoney) || Math.round(receivedMoney * 100) !== order.amountFen) return res.status(400).send('fail');
  if (order.status === 'paid') return res.send('success');
  const plan = store.getPaymentPlan(order.planId);
  if (!plan) return res.status(409).send('fail');
  const paidOrder = store.markPaymentOrderPaid(order.id, Date.now(), query.trade_no || undefined, query.type ? `epay-${query.type}` : undefined);
  // A duplicate callback is expected from payment providers. Once another request
  // has claimed the pending order, acknowledge it without activating the plan again.
  if (!paidOrder) return res.send('success');
  const user = store.setPaid(order.userId, true, plan.id);
  if (user?.paid && store.countUserAssignments(order.userId) === 0) store.assignAvailableAccount(order.userId, plan.seatCount);
  return paidOrder ? res.send('success') : res.status(500).send('fail');
}

app.get('/api/payment/epay/notify', handleEpayNotify);
app.post('/api/payment/epay/notify', handleEpayNotify);

app.post('/api/payment/mock/orders/:id/success', requireUser, (req, res) => {
  return res.status(410).json({ error: '模拟支付已停用，请使用真实支付' });
});

app.get('/api/admin/payment-plans', requirePrimaryAdmin, (_req, res) => {
  return res.json({ plans: store.listPaymentPlans().map(planView) });
});

app.post('/api/admin/payment-plans', requirePrimaryAdmin, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(40),
    seatCount: z.number().int().min(1).max(1000),
    displaySeatCount: z.number().int().min(1).max(1000).optional(),
    amountFen: z.number().int().min(1).max(100_000_000),
    durationDays: z.number().int().min(1).max(3650),
    active: z.boolean().default(true)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '套餐名称、共享人数、价格或周期格式不正确' });
  const now = Date.now();
  const plan: PaymentPlan = { id: `PLAN-${randomId()}`, ...parsed.data, displaySeatCount: parsed.data.displaySeatCount ?? parsed.data.seatCount, createdAt: now, updatedAt: now };
  store.savePaymentPlan(plan);
  return res.status(201).json({ plan: planView(plan) });
});

app.patch('/api/admin/payment-plans/:id', requirePrimaryAdmin, (req, res) => {
  const planId = req.params.id as string;
  const parsed = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    seatCount: z.number().int().min(1).max(1000).optional(),
    displaySeatCount: z.number().int().min(1).max(1000).optional(),
    amountFen: z.number().int().min(1).max(100_000_000).optional(),
    durationDays: z.number().int().min(1).max(3650).optional(),
    active: z.boolean().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '套餐配置格式不正确' });
  const current = store.getPaymentPlan(planId);
  if (!current) return res.status(404).json({ error: '套餐不存在' });
  const plan = store.updatePaymentPlan(planId, parsed.data)!;
  return res.json({ plan: planView(plan) });
});

app.delete('/api/admin/payment-plans/:id', requirePrimaryAdmin, (req, res) => {
  const planId = req.params.id as string;
  const current = store.getPaymentPlan(planId);
  if (!current) return res.status(404).json({ error: '套餐不存在' });
  if (!store.deletePaymentPlan(planId)) return res.status(404).json({ error: '套餐不存在或已经删除' });
  return res.json({ ok: true, planId });
});

app.get('/api/admin/payment-settings', requirePrimaryAdmin, (_req, res) => {
  return res.json({ settings: paymentSettingsView(store.getPaymentSettings()) });
});

app.put('/api/admin/payment-settings', requirePrimaryAdmin, (req, res) => {
  const urlField = z.string().trim().max(500).refine((value) => !value || /^https?:\/\//i.test(value), '地址必须以 http:// 或 https:// 开头');
  const parsed = z.object({
    enabled: z.boolean().default(false),
    gatewayType: z.enum(['epay', 'manual']).default('epay'),
    gatewayUrl: urlField,
    callbackBaseUrl: urlField,
    returnUrl: urlField,
    merchantId: z.string().trim().max(120).default(''),
    merchantKey: z.string().trim().max(500).optional(),
    minAmountFen: z.number().int().min(1).max(100_000_000).default(100)
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '支付配置格式不正确，请检查地址、商户信息和最低金额' });
  const current = store.getPaymentSettings();
  if (parsed.data.enabled && parsed.data.gatewayType === 'epay' && (!parsed.data.gatewayUrl || !parsed.data.callbackBaseUrl || !parsed.data.merchantId || (!parsed.data.merchantKey && !current.encryptedMerchantKey))) {
    return res.status(400).json({ error: '启用易支付前，请填写网关地址、回调地址、商户 ID 和商户密钥' });
  }
  const settings = store.savePaymentSettings({
    id: 'default',
    enabled: parsed.data.enabled,
    gatewayType: parsed.data.gatewayType,
    gatewayUrl: parsed.data.gatewayUrl,
    callbackBaseUrl: parsed.data.callbackBaseUrl,
    returnUrl: parsed.data.returnUrl,
    merchantId: parsed.data.merchantId,
    encryptedMerchantKey: parsed.data.merchantKey ? encryptSecret(parsed.data.merchantKey) : current.encryptedMerchantKey,
    minAmountFen: parsed.data.minAmountFen,
    updatedAt: Date.now()
  });
  return res.json({ settings: paymentSettingsView(settings) });
});

app.get('/api/admin/payment-orders', requirePrimaryAdmin, (_req, res) => {
  const orders = store.listPaymentOrders();
  const summary = {
    total: orders.length,
    pending: orders.filter((order) => order.status === 'pending').length,
    paid: orders.filter((order) => order.status === 'paid').length,
    closed: orders.filter((order) => order.status === 'closed').length,
    paidAmountFen: orders.filter((order) => order.status === 'paid').reduce((total, order) => total + order.amountFen, 0)
  };
  return res.json({ orders: orders.map(paymentOrderView), summary });
});

app.post('/api/admin/payment-orders/:id/confirm', requirePrimaryAdmin, (req, res) => {
  const order = store.getPaymentOrder(req.params.id as string);
  if (!order) return res.status(404).json({ error: '支付订单不存在' });
  if (order.status === 'paid') return res.json({ order: paymentOrderView(order), alreadyPaid: true });
  if (order.status !== 'pending') return res.status(409).json({ error: '只有待支付订单可以确认到账' });
  const parsed = z.object({
    providerTradeNo: z.string().trim().max(120).optional(),
    adminNote: z.string().trim().max(500).optional(),
    paymentMethod: z.string().trim().max(40).default('manual')
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '支付流水号或管理员备注格式不正确' });
  const updated = store.updatePaymentOrder(order.id, {
    providerTradeNo: parsed.data.providerTradeNo || order.providerTradeNo,
    adminNote: parsed.data.adminNote || order.adminNote,
    paymentMethod: parsed.data.paymentMethod
  })!;
  const paidOrder = activatePaidOrder(updated);
  if (!paidOrder) return res.status(409).json({ error: '订单对应套餐不存在，无法确认到账' });
  return res.json({ order: paymentOrderView(paidOrder), user: store.getUser(order.userId) });
});

app.post('/api/admin/payment-orders/:id/close', requirePrimaryAdmin, (req, res) => {
  const order = store.getPaymentOrder(req.params.id as string);
  if (!order) return res.status(404).json({ error: '支付订单不存在' });
  if (order.status === 'paid') return res.status(409).json({ error: '已到账订单不能直接关闭' });
  const parsed = z.object({ adminNote: z.string().trim().max(500).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '管理员备注格式不正确' });
  const updated = store.updatePaymentOrder(order.id, { status: 'closed', adminNote: parsed.data.adminNote || order.adminNote });
  return res.json({ order: paymentOrderView(updated!) });
});

app.patch('/api/admin/payment-orders/:id', requirePrimaryAdmin, (req, res) => {
  const order = store.getPaymentOrder(req.params.id as string);
  if (!order) return res.status(404).json({ error: '支付订单不存在' });
  const parsed = z.object({
    providerTradeNo: z.string().trim().max(120).optional(),
    adminNote: z.string().trim().max(500).optional(),
    paymentMethod: z.string().trim().max(40).optional()
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '支付信息格式不正确' });
  const updated = store.updatePaymentOrder(order.id, parsed.data)!;
  return res.json({ order: paymentOrderView(updated) });
});

app.get('/api/admin/announcements', requireAdmin, (_req, res) => {
  return res.json({ announcements: store.listAnnouncements() });
});

app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const parsed = z.object({
    title: z.string().trim().min(1).max(80),
    content: z.string().trim().min(1).max(3000),
    active: z.boolean().default(true),
    priority: z.number().int().min(0).max(100).default(0),
    startsAt: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional()
  }).safeParse(req.body ?? {});
  if (!parsed.success || (parsed.data.expiresAt && parsed.data.expiresAt <= (parsed.data.startsAt ?? Date.now()))) return res.status(400).json({ error: '请填写正确的公告标题、内容和展示时间' });
  const now = Date.now();
  const announcement = store.saveAnnouncement({ id: `NOTICE-${randomId()}`, ...parsed.data, startsAt: parsed.data.startsAt ?? now, createdAt: now, updatedAt: now });
  return res.status(201).json({ announcement });
});

app.patch('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const current = store.getAnnouncement(req.params.id as string);
  if (!current) return res.status(404).json({ error: '公告不存在' });
  const parsed = z.object({
    title: z.string().trim().min(1).max(80).optional(),
    content: z.string().trim().min(1).max(3000).optional(),
    active: z.boolean().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    startsAt: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().nullable().optional()
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '公告配置格式不正确' });
  const nextStartsAt = parsed.data.startsAt ?? current.startsAt;
  const nextExpiresAt = parsed.data.expiresAt === null ? undefined : (parsed.data.expiresAt ?? current.expiresAt);
  if (nextExpiresAt && nextExpiresAt <= nextStartsAt) return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  const announcement = store.updateAnnouncement(current.id, { ...parsed.data, expiresAt: nextExpiresAt });
  return res.json({ announcement });
});

app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  if (!store.deleteAnnouncement(req.params.id as string)) return res.status(404).json({ error: '公告不存在' });
  return res.json({ ok: true });
});

app.get('/api/support/tickets', requireUser, (req, res) => {
  return res.json({ tickets: store.listSupportTickets(req.userId!).map(supportTicketView) });
});

app.post('/api/support/tickets', requireUser, handleSupportUpload, async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const content = parseSupportContent(req);
  if (subject.length < 2 || subject.length > 80 || !content || (!content.content && !req.file)) {
    removeUploadedFile(req);
    return res.status(400).json({ error: '请填写问题标题和详细内容，或附加一张图片' });
  }
  const now = Date.now();
  const ticket = store.saveSupportTicket({ id: randomId(), userId: req.userId!, subject, status: 'open', createdAt: now, updatedAt: now });
  store.saveSupportMessage({ id: randomId(), ticketId: ticket.id, senderType: 'user', senderId: req.userId!, content: content.content, attachment: supportAttachmentFromRequest(req), createdAt: now });
  queueAutomaticSupportReply(ticket);
  return res.status(201).json({ ticket: supportTicketView(store.getSupportTicket(ticket.id)!) });
});

app.post('/api/support/tickets/:id/messages', requireUser, handleSupportUpload, async (req, res) => {
  const ticket = store.getSupportTicket(req.params.id as string);
  if (!ticket || ticket.userId !== req.userId) { removeUploadedFile(req); return res.status(404).json({ error: '客服工单不存在' }); }
  if (ticket.status === 'closed') { removeUploadedFile(req); return res.status(409).json({ error: '该工单已经关闭，请重新创建工单' }); }
  const content = parseSupportContent(req);
  if (!content || (!content.content && !req.file)) { removeUploadedFile(req); return res.status(400).json({ error: '请输入回复内容或选择一张图片' }); }
  store.saveSupportMessage({ id: randomId(), ticketId: ticket.id, senderType: 'user', senderId: req.userId!, content: content.content, attachment: supportAttachmentFromRequest(req), createdAt: Date.now() });
  store.updateSupportTicket(ticket.id, { status: 'open' });
  queueAutomaticSupportReply(ticket);
  return res.status(201).json({ ticket: supportTicketView(store.getSupportTicket(ticket.id)!) });
});

app.get('/api/admin/support/tickets', requireAdmin, (_req, res) => {
  return res.json({ tickets: store.listSupportTickets().map(supportTicketView) });
});

app.post('/api/admin/support/tickets/:id/reply', requireAdmin, handleSupportUpload, (req, res) => {
  const ticket = store.getSupportTicket(req.params.id as string);
  if (!ticket) { removeUploadedFile(req); return res.status(404).json({ error: '客服工单不存在' }); }
  const content = parseSupportContent(req);
  if (!content || (!content.content && !req.file)) { removeUploadedFile(req); return res.status(400).json({ error: '请输入回复内容或选择一张图片' }); }
  store.saveSupportMessage({ id: randomId(), ticketId: ticket.id, senderType: 'admin', senderId: req.userId!, content: content.content, attachment: supportAttachmentFromRequest(req), createdAt: Date.now() });
  store.updateSupportTicket(ticket.id, { status: 'pending' });
  return res.json({ ticket: supportTicketView(store.getSupportTicket(ticket.id)!) });
});

app.get('/api/support/attachments/:fileName', requireUser, (req, res) => {
  const fileName = path.basename(req.params.fileName as string);
  const message = store.getSupportMessageByAttachment(fileName);
  if (!message) return res.status(404).json({ error: '图片不存在' });
  const ticket = store.getSupportTicket(message.ticketId);
  if (!ticket || (req.role !== 'admin' && ticket.userId !== req.userId)) return res.status(403).json({ error: '无权查看该图片' });
  const filePath = path.join(SUPPORT_UPLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '图片文件不存在' });
  return res.sendFile(filePath, { headers: { 'Cache-Control': 'private, max-age=300' } });
});

app.patch('/api/admin/support/tickets/:id/status', requireAdmin, (req, res) => {
  const parsed = z.object({ status: z.enum(['open', 'pending', 'closed']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '工单状态格式不正确' });
  const ticket = store.updateSupportTicket(req.params.id as string, { status: parsed.data.status });
  if (!ticket) return res.status(404).json({ error: '客服工单不存在' });
  return res.json({ ticket: supportTicketView(ticket) });
});

app.delete('/api/admin/support/tickets/:id', requireAdmin, (req, res) => {
  if (!store.deleteSupportTicket(req.params.id as string)) return res.status(404).json({ error: '客服工单不存在' });
  return res.json({ ok: true });
});

app.post('/api/admin/support/tickets/:id/restore-subscription', requirePrimaryAdmin, (req, res) => {
  const ticket = store.getSupportTicket(req.params.id as string);
  if (!ticket) return res.status(404).json({ error: '客服工单不存在' });
  const parsed = z.object({ days: z.number().int().min(1).max(3650).default(30) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '恢复天数格式不正确' });
  const user = store.getUser(ticket.userId);
  if (!user) return res.status(404).json({ error: '工单用户不存在' });
  const paidUntil = Math.max(Date.now(), user.paidUntil ?? Date.now()) + parsed.data.days * 24 * 60 * 60 * 1000;
  store.setPaidUntil(user.id, paidUntil);
  const restored = store.restorePaid(user.id) ?? store.setPaid(user.id, true);
  if (restored?.paid && store.countUserAssignments(user.id) === 0) store.assignAvailableAccount(user.id);
  return res.json({ user: store.getUser(user.id), paidUntil });
});

app.get('/api/admin/support/ai-config', requireAdmin, (_req, res) => {
  return res.json({ config: supportAiConfigView(store.getSupportAiConfig()) });
});

app.put('/api/admin/support/ai-config', requireAdmin, (req, res) => {
  const parsed = z.object({
    baseUrl: z.string().url().max(500),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().max(500).optional(),
    active: z.boolean().default(true)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '请填写正确的接口地址、模型名称和 API Key' });
  const current = store.getSupportAiConfig();
  if (!parsed.data.apiKey && !current) return res.status(400).json({ error: '首次配置必须填写 API Key' });
  const configValue = store.saveSupportAiConfig({
    id: 'default',
    baseUrl: parsed.data.baseUrl.replace(/\/+$/, ''),
    model: parsed.data.model,
    encryptedApiKey: parsed.data.apiKey ? encryptSecret(parsed.data.apiKey) : current!.encryptedApiKey,
    active: parsed.data.active,
    updatedAt: Date.now()
  });
  return res.json({ config: supportAiConfigView(configValue) });
});

app.post('/api/admin/support/ai-config/test', requireAdmin, async (_req, res) => {
  const aiConfig = store.getSupportAiConfig();
  if (!aiConfig?.active) return res.status(409).json({ error: '请先保存并启用第三方 GPT 客服配置' });
  try {
    const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decryptSecret(aiConfig.encryptedApiKey)}` },
      body: JSON.stringify({ model: aiConfig.model, messages: [{ role: 'user', content: '请只回复：连接成功' }], temperature: 0, max_tokens: 20 }),
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) return res.status(502).json({ error: data.error?.message || `第三方模型请求失败（${response.status}）` });
    return res.json({ ok: true, reply: data.choices?.[0]?.message?.content?.trim() || '连接成功' });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? `第三方模型连接失败：${error.message}` : '第三方模型连接失败' });
  }
});

app.post('/api/admin/support/ai-config/models', requireAdmin, async (req, res) => {
  const parsed = z.object({ baseUrl: z.string().url().max(500), apiKey: z.string().trim().max(500).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '请填写正确的接口地址' });
  const current = store.getSupportAiConfig();
  const apiKey = parsed.data.apiKey?.trim() || (current ? decryptSecret(current.encryptedApiKey) : '');
  if (!apiKey) return res.status(400).json({ error: '请先填写 API Key' });
  try {
    const response = await fetch(`${parsed.data.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json() as { data?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) return res.status(502).json({ error: data.error?.message || `模型列表请求失败（${response.status}）` });
    const models = (data.data || []).map((item) => item.id?.trim()).filter((item): item is string => Boolean(item));
    return res.json({ models });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? `模型检测失败：${error.message}` : '模型检测失败' });
  }
});

app.post('/api/admin/mail-accounts/test', requireAdmin, async (req, res) => {
  const parsed = z.object({
    email: z.string().email(),
    appPassword: z.string().min(8).max(128)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '请填写正确的邮箱和客户端授权码' });
  const email = parsed.data.email.toLowerCase();
  const provider = providerForEmail(email);
  if (!provider) return res.status(400).json({ error: '暂只支持 163.com、126.com、yeah.net 邮箱' });
  const connection = {
    id: `test:${randomId()}`,
    userId: 'managed-account-test',
    email,
    encryptedAppPassword: encryptSecret(parsed.data.appPassword),
    provider,
    createdAt: Date.now()
  };
  try {
    await findLatestOtp(connection, new Date(Date.now() - 60_000));
    const testToken = randomId();
    const expiresAt = Date.now() + MANAGED_ACCOUNT_TEST_TTL_MS;
    managedAccountTests.set(testToken, { digest: hashCode(`${email}\n${parsed.data.appPassword}`), expiresAt });
    for (const [token, test] of managedAccountTests) {
      if (test.expiresAt <= Date.now()) managedAccountTests.delete(token);
    }
    return res.json({ ok: true, testToken, expiresAt });
  } catch {
    return res.status(502).json({ error: '邮箱连接失败，请检查邮箱、客户端授权码和 IMAP 服务' });
  }
});

app.post('/api/admin/mail-accounts', requireAdmin, (req, res) => {
  const parsed = z.object({
    email: z.string().email(),
    appPassword: z.string().min(8).max(128),
    loginPassword: z.string().max(128).optional(),
    maxUsers: z.number().int().min(1).max(1000),
    note: z.string().trim().max(200).default(''),
    testToken: z.string().uuid()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '邮箱、客户端授权码、登录密码、人数上限或测试凭证格式不正确' });
  const email = parsed.data.email.toLowerCase();
  const provider = providerForEmail(email);
  if (!provider) return res.status(400).json({ error: '暂只支持 163.com、126.com、yeah.net 邮箱' });
  const tested = managedAccountTests.get(parsed.data.testToken);
  if (!tested || tested.expiresAt <= Date.now() || tested.digest !== hashCode(`${email}\n${parsed.data.appPassword}`)) {
    managedAccountTests.delete(parsed.data.testToken);
    return res.status(409).json({ error: '连接测试已失效或账号信息已改变，请重新测试' });
  }
  if (store.getManagedAccountByEmail(email)) return res.status(409).json({ error: '该邮箱已经在账号池中' });
  const account: ManagedMailAccount = {
    id: randomId(),
    userId: `managed:${randomId()}`,
    email,
    encryptedAppPassword: encryptSecret(parsed.data.appPassword),
    encryptedLoginPassword: parsed.data.loginPassword ? encryptSecret(parsed.data.loginPassword) : undefined,
    provider,
    note: parsed.data.note,
    maxUsers: parsed.data.maxUsers,
    active: true,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    createdAt: Date.now()
  };
  store.saveManagedAccount(account);
  managedAccountTests.delete(parsed.data.testToken);
  return res.status(201).json({ id: account.id, email: account.email, provider: account.provider, note: account.note, maxUsers: account.maxUsers, active: account.active, expiresAt: account.expiresAt });
});

app.get('/api/admin/mail-accounts', requireAdmin, (_req, res) => {
  return res.json({ accounts: store.listManagedAccounts().map((account) => ({
    id: account.id,
    email: account.email,
    provider: account.provider,
    note: account.note,
    maxUsers: account.maxUsers,
    assignedUsers: store.countAssignments(account.id),
    active: account.active,
    expiresAt: account.expiresAt
  })) });
});

app.post('/api/admin/mail-accounts/:id/credentials', requirePrimaryAdmin, (req, res) => {
  const account = store.getManagedAccount(req.params.id as string);
  if (!account) return res.status(404).json({ error: '邮箱账号不存在' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json({
      credentials: {
        email: account.email,
        appPassword: decryptSecret(account.encryptedAppPassword),
        loginPassword: account.encryptedLoginPassword ? decryptSecret(account.encryptedLoginPassword) : null
      }
    });
  } catch {
    return res.status(500).json({ error: '密码解密失败，请检查主密钥配置' });
  }
});

app.post('/api/admin/mail-accounts/batch-update', requireAdmin, (req, res) => {
  const parsed = z.object({
    accountIds: z.array(z.string().uuid()).min(1).max(1000),
    maxUsers: z.number().int().min(1).max(1000).optional(),
    expiresAt: z.number().int().min(946684800000).optional(),
    active: z.boolean().optional(),
    note: z.string().trim().max(200).optional()
  }).refine((data) => data.maxUsers !== undefined || data.expiresAt !== undefined || data.active !== undefined || data.note !== undefined, {
    message: '至少填写一项批量修改内容'
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '请选择账号并填写至少一项批量修改内容' });

  const accountIds = [...new Set(parsed.data.accountIds)];
  const accounts = accountIds.map((id) => store.getManagedAccount(id));
  if (accounts.some((account) => !account)) return res.status(404).json({ error: '部分账号不存在，请刷新后重试' });
  const existingAccounts = accounts as ManagedMailAccount[];
  if (parsed.data.maxUsers !== undefined) {
    const invalid = existingAccounts.find((account) => parsed.data.maxUsers! < store.countAssignments(account.id));
    if (invalid) return res.status(409).json({ error: `${invalid.email} 已分配 ${store.countAssignments(invalid.id)} 个用户，人数上限不能低于已分配人数` });
  }
  if (parsed.data.expiresAt !== undefined && parsed.data.expiresAt > Date.now() + 5 * 365 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: '到期时间不能超过未来 5 年' });
  }

  const updated = existingAccounts.map((account) => store.updateManagedAccount(account.id, {
    ...(parsed.data.maxUsers === undefined ? {} : { maxUsers: parsed.data.maxUsers }),
    ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt }),
    ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
    ...(parsed.data.note === undefined ? {} : { note: parsed.data.note })
  })!);
  return res.json({ accounts: updated.map((account) => ({ id: account.id, email: account.email, note: account.note, maxUsers: account.maxUsers, active: account.active, expiresAt: account.expiresAt })) });
});

app.post('/api/admin/mail-accounts/:id/test', requireAdmin, async (req, res) => {
  const accountId = req.params.id as string;
  const account = store.getManagedAccount(accountId);
  if (!account) return res.status(404).json({ error: '管理员账号不存在' });
  try {
    await findLatestOtp(account, new Date(Date.now() - 60_000));
    return res.json({ ok: true, accountId, testedAt: Date.now() });
  } catch {
    return res.status(502).json({ error: '邮箱连接失败，请检查账号授权码或 IMAP 服务是否开启', accountId });
  }
});

app.patch('/api/admin/mail-accounts/:id', requireAdmin, (req, res) => {
  const accountId = req.params.id as string;
  const parsed = z.object({
    email: z.string().email().optional(),
    appPassword: z.string().min(8).max(128).optional(),
    loginPassword: z.string().max(128).optional(),
    note: z.string().trim().max(200).optional(),
    maxUsers: z.number().int().min(1).max(1000).optional(),
    active: z.boolean().optional(),
    expiresAt: z.number().int().min(946684800000).optional(),
    renewDays: z.literal(30).optional()
  }).refine((data) => !(data.expiresAt !== undefined && data.renewDays !== undefined)).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '账号配置格式不正确' });
  if (req.adminLevel !== 'primary' && (parsed.data.appPassword !== undefined || parsed.data.loginPassword !== undefined)) {
    return res.status(403).json({ error: '次级管理员不能修改邮箱密码或客户端授权码' });
  }
  const current = store.getManagedAccount(accountId);
  if (!current) return res.status(404).json({ error: '管理员账号不存在' });
  const email = parsed.data.email?.toLowerCase();
  const provider = email ? providerForEmail(email) : undefined;
  if (email && !provider) return res.status(400).json({ error: '暂只支持 163.com、126.com、yeah.net 邮箱' });
  const duplicate = email ? store.getManagedAccountByEmail(email) : undefined;
  if (duplicate && duplicate.id !== accountId) return res.status(409).json({ error: '该邮箱已经在账号池中' });
  const assignedUsers = store.countAssignments(accountId);
  if (parsed.data.maxUsers !== undefined && parsed.data.maxUsers < assignedUsers) {
    return res.status(409).json({ error: `该账号已有 ${assignedUsers} 个用户，人数上限不能低于已分配人数` });
  }
  const maxExpiry = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
  if (parsed.data.expiresAt !== undefined && parsed.data.expiresAt > maxExpiry) {
    return res.status(400).json({ error: '到期时间不能超过未来 5 年' });
  }
  const expiresAt = parsed.data.renewDays
    ? Math.max(Date.now(), current.expiresAt) + parsed.data.renewDays * 24 * 60 * 60 * 1000
    : parsed.data.expiresAt;
  const patch = {
    ...(email === undefined ? {} : { email, provider: provider! }),
    ...(parsed.data.appPassword === undefined ? {} : { encryptedAppPassword: encryptSecret(parsed.data.appPassword) }),
    ...(parsed.data.loginPassword === undefined ? {} : { encryptedLoginPassword: parsed.data.loginPassword ? encryptSecret(parsed.data.loginPassword) : undefined }),
    ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    ...(parsed.data.maxUsers === undefined ? {} : { maxUsers: parsed.data.maxUsers }),
    ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
  const account = store.updateManagedAccount(accountId, patch)!;
  return res.json({ id: account.id, email: account.email, note: account.note, maxUsers: account.maxUsers, active: account.active, expiresAt: account.expiresAt, assignedUsers });
});

app.delete('/api/admin/mail-accounts/:id', requireAdmin, (req, res) => {
  const accountId = req.params.id as string;
  if (!store.getManagedAccount(accountId)) return res.status(404).json({ error: '管理员账号不存在' });
  const assignedUsers = store.countAssignments(accountId);
  if (assignedUsers > 0) return res.status(409).json({ error: `该账号仍绑定 ${assignedUsers} 个用户，请先在用户管理中解绑` });
  store.deleteManagedAccount(accountId);
  return res.json({ ok: true });
});

app.get('/api/admin/administrators', requirePrimaryAdmin, (_req, res) => {
  return res.json({ administrators: store.listAdmins().map(authUserView) });
});

app.post('/api/admin/administrators', requirePrimaryAdmin, (req, res) => {
  const parsed = z.object({
    account: adminAccountSchema,
    password: passwordSchema,
    confirmPassword: z.string().max(128)
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '管理员信息格式不正确' });
  if (parsed.data.password !== parsed.data.confirmPassword) return res.status(400).json({ error: '两次输入的密码不一致' });
  if (store.getUser(parsed.data.account)) return res.status(409).json({ error: '该账号已经存在' });
  const administrator = store.createSecondaryAdmin(parsed.data.account, hashPassword(parsed.data.password));
  if (!administrator) return res.status(409).json({ error: '该账号已经存在' });
  return res.status(201).json({ administrator: authUserView(administrator) });
});

app.patch('/api/admin/administrators/:id/status', requirePrimaryAdmin, (req, res) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '启用状态格式不正确' });
  const administrator = store.setSecondaryAdminActive(req.params.id as string, parsed.data.active);
  if (!administrator) return res.status(404).json({ error: '次级管理员不存在' });
  return res.json({ administrator: authUserView(administrator) });
});

app.patch('/api/admin/administrators/:id/password', requirePrimaryAdmin, (req, res) => {
  const parsed = z.object({ password: passwordSchema, confirmPassword: z.string().max(128) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '密码格式不正确' });
  if (parsed.data.password !== parsed.data.confirmPassword) return res.status(400).json({ error: '两次输入的密码不一致' });
  const administrator = store.getUser(req.params.id as string);
  if (!administrator || administrator.role !== 'admin' || administrator.adminLevel !== 'secondary') {
    return res.status(404).json({ error: '次级管理员不存在' });
  }
  store.saveUserPasswordHash(administrator.id, hashPassword(parsed.data.password));
  store.deleteAuthSessionsForUser(administrator.id);
  return res.json({ ok: true, administrator: authUserView(store.getUser(administrator.id)!) });
});

app.delete('/api/admin/administrators/:id', requirePrimaryAdmin, (req, res) => {
  const parsed = z.object({ adminPassword: z.string().min(1).max(128) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '请输入当前主管理员密码' });
  const passwordHash = store.getUserPasswordHash(req.userId!);
  if (!passwordHash || !verifyPassword(parsed.data.adminPassword, passwordHash)) {
    return res.status(403).json({ error: '主管理员密码不正确' });
  }
  const administratorId = req.params.id as string;
  if (!store.deleteSecondaryAdmin(administratorId)) return res.status(404).json({ error: '次级管理员不存在' });
  return res.json({ ok: true, administratorId });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const users = store.listUsers();
  const requestCounts = new Map<string, number>();
  for (const request of store.listRequests()) requestCounts.set(request.userId, (requestCounts.get(request.userId) ?? 0) + 1);
  return res.json({
    users: users.map((user) => {
      const assignments = store.listAssignmentsForUser(user.id);
      return {
      ...user,
      hasMailbox: assignments.length > 0,
      mailbox: assignments[0]?.account.email,
      assignments: assignments.map(assignmentView),
      requestCount: requestCounts.get(user.id) ?? 0
      };
    })
  });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const parsed = z.object({ userId: z.string().trim().min(2).max(64), paid: z.boolean().default(false) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '用户 ID 格式不正确' });
  if (req.adminLevel !== 'primary' && parsed.data.paid) return res.status(403).json({ error: '次级管理员不能为用户开通订阅' });
  if (store.getUser(parsed.data.userId)) return res.status(409).json({ error: '用户已存在' });
  const user = store.ensureUser(parsed.data.userId, parsed.data.paid);
  const assignment = parsed.data.paid ? store.assignAvailableAccount(user.id) : undefined;
  return res.status(201).json({ user, assignment: assignment ? { id: assignment.id, email: assignment.email } : null });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ adminPassword: z.string().min(1).max(128) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '请输入管理员登录密码后再删除用户' });

  const adminPasswordHash = store.getUserPasswordHash(req.userId!);
  if (!adminPasswordHash || !verifyPassword(parsed.data.adminPassword, adminPasswordHash)) {
    return res.status(403).json({ error: '管理员登录密码不正确，已取消删除' });
  }

  const current = store.getUser(userId);
  if (!current) return res.status(404).json({ error: '用户不存在' });
  if (current.role === 'admin' || current.id === req.userId) {
    return res.status(409).json({ error: '管理员账号不能删除' });
  }
  if (!store.deleteUser(userId)) return res.status(404).json({ error: '用户不存在' });
  return res.json({ ok: true, userId });
});

app.patch('/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({
    password: passwordSchema,
    confirmPassword: z.string(),
    adminPassword: z.string().min(1).max(128),
    confirmation: z.literal('确认重置')
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '请填写新密码、管理员密码，并输入“确认重置”' });
  if (parsed.data.password !== parsed.data.confirmPassword) return res.status(400).json({ error: '两次输入的密码不一致' });

  const adminPasswordHash = store.getUserPasswordHash(req.userId!);
  if (!adminPasswordHash || !verifyPassword(parsed.data.adminPassword, adminPasswordHash)) {
    return res.status(403).json({ error: '当前管理员密码不正确，密码未修改' });
  }

  const current = store.getUser(userId);
  if (!current) return res.status(404).json({ error: '用户不存在' });
  if (current.role === 'admin') return res.status(409).json({ error: '管理员账号不能通过此处重置密码' });
  if (!store.saveUserPasswordHash(userId, hashPassword(parsed.data.password))) {
    return res.status(404).json({ error: '用户不存在' });
  }
  store.deleteAuthSessionsForUser(userId);
  return res.json({ ok: true, userId });
});

app.patch('/api/admin/users/:id/paid', requirePrimaryAdmin, (req, res) => {
  const paid = z.object({ paid: z.boolean() }).safeParse(req.body);
  const userId = req.params.id as string;
  if (!paid.success) return res.status(400).json({ error: 'paid 必须是布尔值' });
  const current = store.getUser(userId);
  if (!current) return res.status(404).json({ error: '用户不存在' });
  const user = paid.data.paid
    ? (current.paidUntil && current.paidUntil > Date.now() ? store.restorePaid(userId) : store.setPaid(userId, true))
    : store.pausePaid(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const assignment = paid.data.paid && store.countUserAssignments(userId) === 0 ? store.assignAvailableAccount(userId) : undefined;
  return res.json({ user, assignment: assignment ? { email: assignment.email } : null });
});

app.patch('/api/admin/users/:id/subscription', requirePrimaryAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ action: z.enum(['pause', 'restore', 'activate']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '订阅操作格式不正确' });
  const current = store.getUser(userId);
  if (!current) return res.status(404).json({ error: '用户不存在' });

  let user;
  if (parsed.data.action === 'pause') {
    if (!current.paid || !current.paidUntil) return res.status(409).json({ error: '该用户当前没有可暂停的有效订阅' });
    user = store.pausePaid(userId);
  } else if (parsed.data.action === 'restore') {
    user = store.restorePaid(userId);
    if (!user) return res.status(409).json({ error: '原到期时间已失效，请先设置新的未来到期日期' });
  } else {
    user = store.setPaid(userId, true);
  }

  const assignment = user?.paid && store.countUserAssignments(userId) === 0
    ? store.assignAvailableAccount(userId)
    : undefined;
  return res.json({ user, assignment: assignment ? { id: assignment.id, email: assignment.email } : null });
});

app.patch('/api/admin/users/:id/expiry', requirePrimaryAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ paidUntil: z.number().int() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '到期时间格式不正确' });
  if (parsed.data.paidUntil <= Date.now()) return res.status(400).json({ error: '到期时间必须晚于当前时间' });
  if (parsed.data.paidUntil > Date.now() + 5 * 365 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: '到期时间不能超过未来 5 年' });
  }
  if (!store.getUser(userId)) return res.status(404).json({ error: '用户不存在' });
  const user = store.setPaidUntil(userId, parsed.data.paidUntil)!;
  return res.json({ user });
});

app.patch('/api/admin/users/:id/mail-limit', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ maxMailAccounts: z.number().int().min(1).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: '账号数量权限必须是 1 到 20 的整数' });
  const user = store.getUser(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const assignedCount = store.countUserAssignments(userId);
  if (parsed.data.maxMailAccounts < assignedCount) {
    return res.status(409).json({ error: `该用户已有 ${assignedCount} 个账号，请先解绑多余账号` });
  }
  const updated = store.setMaxMailAccounts(userId, parsed.data.maxMailAccounts)!;
  return res.json({ user: updated, assignedCount });
});

app.patch('/api/admin/users/:id/mail-credentials', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '账号密码权限必须是布尔值' });
  const user = store.getUser(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin') return res.status(409).json({ error: '管理员不需要配置该权限' });
  const updated = store.setCanViewMailCredentials(userId, parsed.data.enabled)!;
  return res.json({ user: updated });
});

app.post('/api/admin/users/:id/mail-accounts', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const parsed = z.object({ accountId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '邮箱账号参数格式不正确' });
  const user = store.getUser(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.paid) return res.status(409).json({ error: '只能为有效付费用户分配账号' });
  if (store.countUserAssignments(userId) >= user.maxMailAccounts) {
    return res.status(409).json({ error: `该用户最多只能拥有 ${user.maxMailAccounts} 个账号` });
  }

  let account: ManagedMailAccount | undefined;
  if (parsed.data.accountId) {
    const requested = store.getManagedAccount(parsed.data.accountId);
    if (!requested) return res.status(404).json({ error: '指定的邮箱账号不存在' });
    if (!requested.active) return res.status(409).json({ error: '指定的邮箱账号已停用' });
    if (store.isAssignedToUser(userId, requested.id)) return res.status(409).json({ error: '该账号已经分配给此用户' });
    if (store.countAssignments(requested.id) >= requested.maxUsers) return res.status(409).json({ error: '指定的邮箱账号已达到用户上限' });
    account = store.assignAccountToUser(userId, requested.id, 'admin');
  } else {
    account = store.assignAvailableAccount(userId);
  }
  if (!account) return res.status(409).json({ error: '没有符合条件的可用邮箱账号' });
  return res.status(201).json({ assignment: { id: account.id, email: account.email, source: parsed.data.accountId ? 'admin' : 'auto' } });
});

app.delete('/api/admin/users/:id/mail-accounts/:accountId', requireAdmin, (req, res) => {
  const userId = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!store.getUser(userId)) return res.status(404).json({ error: '用户不存在' });
  if (!store.unassignAccountFromUser(userId, accountId)) return res.status(404).json({ error: '该分配关系不存在' });
  return res.json({ ok: true });
});

app.post('/api/mail/bind', requirePaidUser, (_req, res) => {
  return res.status(403).json({ error: '邮箱账号只能由系统随机分配或管理员指定，用户不能自行绑定新账号' });
});

app.post('/api/mail/test', requirePaidUser, async (req, res) => {
  const parsed = z.object({ accountId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '账号参数格式不正确' });
  const connection = store.getConnectionForUser(req.userId!, parsed.data.accountId);
  if (!connection) return res.status(409).json({ error: '暂时没有可分配账号，请联系管理员补充账号名额' });
  try {
    await findLatestOtp(connection, new Date(Date.now() - 60_000));
    return res.json({ ok: true });
  } catch {
    return res.status(502).json({ error: '邮箱连接失败' });
  }
});

app.post('/api/mail/credentials', requirePaidUser, (req, res) => {
  const user = store.getUser(req.userId!);
  if (!user?.canViewMailCredentials) return res.status(403).json({ error: '管理员尚未开启账号密码查看权限' });
  const parsed = z.object({ accountId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '账号参数格式不正确' });
  const assignments = store.listAssignmentsForUser(req.userId!);
  const selected = parsed.data.accountId
    ? assignments.find((item) => item.account.id === parsed.data.accountId)
    : assignments[0];
  if (!selected) return res.status(404).json({ error: '没有找到已分配的邮箱账号' });
  try {
    const credential = mailCredentialView(selected.account);
    if (!credential) return res.status(409).json({ error: '管理员尚未为该邮箱配置登录密码' });
    return res.json({ credential });
  } catch {
    return res.status(500).json({ error: '账号授权码读取失败，请联系管理员' });
  }
});

app.post('/api/otp/requests', requirePaidUser, async (req, res) => {
  const parsed = z.object({ accountId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: '账号参数格式不正确' });
  const connection = store.getConnectionForUser(req.userId!, parsed.data.accountId);
  if (!connection) return res.status(409).json({ error: '暂时没有可分配账号，请联系管理员补充账号名额' });
  const pendingRequest = store.getPendingRequestForConnection(connection.id);
  if (pendingRequest && pendingRequest.userId === req.userId) {
    return res.status(202).json({
      requestId: pendingRequest.id,
      expiresAt: pendingRequest.expiresAt,
      resumed: true
    });
  }
  if (pendingRequest) {
    return res.status(409).json({ error: '该共享账号正在处理另一条验证码请求，请稍后再试' });
  }
  const now = Date.now();
  const request: OtpRequest = {
    id: randomId(),
    userId: req.userId!,
    connectionId: connection.id,
    status: 'pending',
    createdAt: now,
    expiresAt: now + config.OTP_TTL_SECONDS * 1000
  };
  store.saveRequest(request);

  const searchAfter = new Date(now - config.OTP_LOOKBACK_MINUTES * 60_000);
  const controller = new AbortController();
  otpControllers.set(request.id, controller);
  void waitForOtp(connection, searchAfter, request.expiresAt, controller.signal)
    .then((code) => {
      const current = store.getRequest(request.id);
      if (!current || current.status !== 'pending') return;
      if (code) store.updateRequest(request.id, { status: 'found', codeHash: hashCode(code) });
      else store.updateRequest(request.id, { status: 'expired' });
    })
    .catch(() => {
      const current = store.getRequest(request.id);
      if (current?.status === 'pending') store.updateRequest(request.id, { status: 'failed', error: '邮箱连接失败' });
    })
    .finally(() => otpControllers.delete(request.id));

  return res.status(202).json({ requestId: request.id, expiresAt: request.expiresAt });
});

app.get('/api/otp/requests/:id', requirePaidUser, (req, res) => {
  const requestId = req.params.id as string;
  const request = store.getRequest(requestId);
  if (!request || request.userId !== req.userId) return res.status(404).json({ error: '请求不存在' });
  if (request.expiresAt <= Date.now() && request.status === 'pending') {
    store.updateRequest(request.id, { status: 'expired' });
  }
  const current = store.getRequest(request.id)!;
  const error = current.error === 'mail_connection_failed' ? '邮箱连接失败' : current.error;
  return res.json({ requestId: current.id, status: current.status, expiresAt: current.expiresAt, error });
});

app.post('/api/otp/requests/:id/cancel', requirePaidUser, (req, res) => {
  const requestId = req.params.id as string;
  const request = store.getRequest(requestId);
  if (!request || request.userId !== req.userId) return res.status(404).json({ error: '请求不存在' });
  if (request.status !== 'pending') return res.status(409).json({ error: '该请求已经结束' });
  otpControllers.get(request.id)?.abort();
  otpControllers.delete(request.id);
  store.updateRequest(request.id, { status: 'failed', error: 'cancelled' });
  return res.json({ ok: true, requestId: request.id });
});

app.post('/api/otp/requests/:id/consume', requirePaidUser, async (req, res) => {
  const requestId = req.params.id as string;
  const request = store.getRequest(requestId);
  if (!request || request.userId !== req.userId) return res.status(404).json({ error: '请求不存在' });
  if (request.status !== 'found' || request.consumedAt || request.expiresAt <= Date.now()) {
    return res.status(409).json({ error: '验证码不存在、已过期或已使用' });
  }
  // The plaintext OTP is intentionally not persisted. Read it once more immediately,
  // then consume the request. In production, use a short-lived encrypted cache instead.
  const connection = store.getConnectionForUser(req.userId!, request.connectionId);
  if (!connection) return res.status(404).json({ error: '邮箱绑定不存在' });
  const searchAfter = new Date(request.createdAt - config.OTP_LOOKBACK_MINUTES * 60_000);
  const code = await findLatestOtp(connection, searchAfter);
  if (!code || hashCode(code) !== request.codeHash) return res.status(409).json({ error: '验证码已变化，请重新获取' });
  store.updateRequest(request.id, { consumedAt: Date.now() });
  return res.json({ code });
});

app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));

app.listen(config.PORT, config.HOST, () => {
  console.log(`OTP gateway listening on http://${config.HOST}:${config.PORT}`);
});
