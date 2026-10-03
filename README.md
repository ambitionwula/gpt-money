# NetEase 邮箱验证码网关（起步版）

这是一个“用户明确授权后，由后端读取其邮箱验证码”的最小后端骨架。

当前实现包含：

- 付费用户中间件（示例使用 `x-user-id` 与 `x-paid-user` 请求头，接入现有 JWT/Session 时替换 `src/auth.ts`）。
- 163.com、126.com、yeah.net 邮箱识别。
- 客户端授权码使用 AES-256-GCM 加密后保存。
- IMAP over TLS 读取最近邮件。
- 验证码请求的过期、归属用户校验和一次性消费。
- 验证码明文不写入持久化存储，只在消费响应时返回。
- SQLite 持久化用户、订单、管理员邮箱池、账号分配和验证码请求；服务重启后配置不会丢失。
- 支付或管理员开通后自动获得 30 天有效期；到期后自动停用付费权限并释放邮箱名额。
- 普通用户默认只能拥有 1 个随机分配账号；管理员可提高账号数量权限、指定账号、随机追加或解绑账号。
- 多账号用户只能在自己已分配的账号中切换使用，不能自行绑定账号池外的邮箱。

## 启动

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 将上一步输出填入 .env 的 MASTER_KEY_HEX
npm run typecheck
npm run build
npm start
```

## API 示例

请求头中的身份字段只是演示，生产环境必须替换为你现有的登录态：

```text
x-user-id: user-123
x-paid-user: true
```

绑定邮箱：

```http
POST /api/mail/bind
Content-Type: application/json

{"email":"your-name@163.com","appPassword":"邮箱客户端授权码"}
```

测试 IMAP 连接：

```http
POST /api/mail/test
```

创建验证码请求：

```http
POST /api/otp/requests
```

默认会先查询最近 5 分钟内的邮件，并继续等待最多 5 分钟；可通过
`OTP_LOOKBACK_MINUTES` 和 `OTP_TTL_SECONDS` 调整。

轮询状态：

```http
GET /api/otp/requests/{requestId}
```

消费验证码：

```http
POST /api/otp/requests/{requestId}/consume
```

## 上线前必须替换的部分

1. 当前使用本地 SQLite；多实例部署时应迁移到 PostgreSQL，并使用 Redis 协调验证码轮询锁。
2. `src/auth.ts` 接入真实用户身份和付费订阅校验。
3. 配置允许的验证码发件人和邮件主题，避免从普通邮件中误提取数字。
4. 增加速率限制、审计日志、管理员解绑、密钥轮换和数据删除流程。
5. 确保用户只对自己的邮箱授权，并在绑定时展示隐私和授权说明。
6. 如果你的登录流程能拿到一次性 challenge/request id，应把它写入邮件匹配规则，避免误取旧验证码。

> 不要把邮箱登录密码交给系统，也不要在前端直接连接 IMAP。这里的 `appPassword` 必须是邮箱服务提供的第三方客户端授权凭据。
