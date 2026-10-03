const $ = (id) => document.getElementById(id);
let requestId = null;
let pollTimer = null;
let paymentOrderId = null;
let mode = 'user';
let selectedAccountId = null;
let managedAccounts = [];
let paymentPlans = [];
let selectedPlanId = null;
let otpVisible = true;
let lastOtpCode = '';
const AUTH_TOKEN_KEY = 'gpt-money-auth-token';
let canViewMailCredentials = false;

async function accountUsageAllowed() {
  if ($('accountUsageAcknowledged')?.checked) return true;
  return openAccountUsageModal();
}

function openAccountUsageModal() {
  return new Promise((resolve) => {
    const modal = $('accountUsageModal');
    if (!modal) { resolve(false); return; }
    const confirmButton = $('confirmAccountUsageBtn');
    const cancelButton = $('cancelAccountUsageBtn');
    modal.hidden = false;
    const finish = (confirmed) => {
      modal.hidden = true;
      confirmButton.onclick = null;
      cancelButton.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKeyDown);
      if (confirmed) $('accountUsageAcknowledged').checked = true;
      resolve(confirmed);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKeyDown);
    confirmButton.focus();
  });
}

async function loadAnnouncements() {
  const button = $('announcementFloatBtn');
  const list = $('announcementList');
  if (!button || !list) return;
  try {
    const response = await fetch('/api/announcements');
    const data = await response.json();
    const announcements = data.announcements || [];
    if (!announcements.length) { button.hidden = true; $('announcementPanel').hidden = true; return; }
    button.hidden = false;
    $('announcementCount').textContent = String(announcements.length);
    list.innerHTML = announcements.map((item) => `<article class="announcement-item"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.content)}</p><small>${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(item.startsAt))}</small></article>`).join('');
  } catch { button.hidden = true; $('announcementPanel').hidden = true; }
}

$('announcementFloatBtn')?.addEventListener('click', () => {
  const panel = $('announcementPanel');
  panel.hidden = !panel.hidden;
  $('announcementFloatBtn').classList.toggle('is-open', !panel.hidden);
});
$('closeAnnouncementBtn')?.addEventListener('click', () => {
  $('announcementPanel').hidden = true;
  $('announcementFloatBtn').classList.remove('is-open');
});

function headers(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function log(message, data) {
  const logElement = $('log');
  if (logElement) logElement.textContent = `${new Date().toLocaleTimeString()}  ${message}${data ? `\n${JSON.stringify(data, null, 2)}` : ''}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function showResult(id, message, ok = true) { const el = $(id); el.textContent = message; el.className = `result ${ok ? 'success' : 'error'}`; }

function formatExpiry(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(value));
}

function formatDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function formatPlanPrice(amountFen) {
  return `¥${(amountFen / 100).toFixed(2)}`;
}

function openOtpConfirmModal() {
  return new Promise((resolve) => {
    const modal = $('otpConfirmModal');
    const confirmButton = $('confirmOtpBtn');
    const cancelButton = $('cancelOtpConfirmBtn');
    const accountName = $('assignmentStatus').textContent || '当前分配的邮箱账号';
    $('otpConfirmText').innerHTML = `将为 <strong>${escapeHtml(accountName)}</strong> 开始获取验证码。<br><span>系统会查询最近 5 分钟邮件，并持续等待新验证码，最长等待 5 分钟。</span>`;
    modal.hidden = false;
    const finish = (confirmed) => {
      modal.hidden = true;
      confirmButton.disabled = false;
      confirmButton.textContent = '确认开始';
      cancelButton.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKeyDown);
      resolve(confirmed);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKeyDown);
    confirmButton.focus();
  });
}

function renderOtpCode(code) {
  lastOtpCode = code || '';
  $('otpCode').textContent = lastOtpCode || '——';
  $('otpCode').classList.toggle('is-hidden', !otpVisible && Boolean(lastOtpCode));
  $('toggleOtpVisibilityBtn').hidden = !lastOtpCode;
}

function openPaymentConfirmModal(plan) {
  return new Promise((resolve) => {
    const modal = $('paymentConfirmModal');
    const confirmButton = $('confirmPaymentBtn');
    const cancelButton = $('cancelPaymentConfirmBtn');
    $('paymentConfirmText').innerHTML = `你选择了「${escapeHtml(plan.name)}」<br><strong>${formatPlanPrice(plan.amountFen)}</strong> · ${plan.durationDays}天 · ${plan.displaySeatCount ?? plan.seatCount}人共享<br><span>确认后将创建一笔待支付订单。</span>`;
    modal.hidden = false;
    const finish = (confirmed) => {
      modal.hidden = true;
      confirmButton.disabled = false;
      confirmButton.textContent = '确认创建订单';
      cancelButton.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKeyDown);
      resolve(confirmed);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKeyDown);
    confirmButton.focus();
  });
}

function renderPaymentPlans(plans, currentPlanId = null, subscriptionLocked = false) {
  paymentPlans = plans;
  if (!plans.length) {
    selectedPlanId = null;
    $('paymentPlans').innerHTML = '<div class="empty-inline">暂无可购买套餐，请联系管理员配置</div>';
    return;
  }
  selectedPlanId = plans.some((plan) => plan.id === selectedPlanId)
    ? selectedPlanId
    : (plans.some((plan) => plan.id === currentPlanId) ? currentPlanId : plans[0].id);
  $('paymentPlans').innerHTML = plans.map((plan) => `
    <button type="button" class="payment-plan ${plan.id === selectedPlanId ? 'active' : ''}" data-plan-choice="${escapeHtml(plan.id)}" ${subscriptionLocked ? 'disabled' : ''}>
      <span class="payment-plan-name">${escapeHtml(plan.name)}</span>
      <strong>${formatPlanPrice(plan.amountFen)}</strong>
      <small>${plan.displaySeatCount ?? plan.seatCount}人共享 · ${plan.durationDays}天${subscriptionLocked ? ' · 当前套餐' : ''}</small>
    </button>`).join('');
  document.querySelectorAll('[data-plan-choice]').forEach((button) => {
    button.onclick = () => {
      selectedPlanId = button.dataset.planChoice;
      renderPaymentPlans(paymentPlans, currentPlanId, subscriptionLocked);
    };
  });
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('复制失败，请手动复制账号');
}

function renderAssignmentChoices(assignments, maxMailAccounts, assignmentPending = false) {
  $('credentialsPanel').hidden = true;
  $('credentialsPanel').innerHTML = '';
  if (!assignments.length) {
    selectedAccountId = null;
    $('assignmentPicker').hidden = true;
    $('assignmentStatus').textContent = assignmentPending ? '已付费，等待管理员账号名额' : '支付后自动分配';
    $('getCredentialsBtn').hidden = true;
    return;
  }

  selectedAccountId = assignments.some((item) => item.id === selectedAccountId) ? selectedAccountId : assignments[0].id;
  $('assignmentPicker').hidden = false;
  $('assignmentCount').textContent = `已分配 ${assignments.length} / ${maxMailAccounts || 1} 个账号`;
  $('accountChoices').innerHTML = assignments.map((item) => `
    <div class="account-choice-card ${item.id === selectedAccountId ? 'active' : ''}">
      <button type="button" class="account-choice" data-account-choice="${escapeHtml(item.id)}">
        <span>${escapeHtml(item.email)}</span>
        <small>${item.active === false ? '已停用' : ''}</small>
      </button>
      <button type="button" class="copy-account-btn" data-copy-account="${escapeHtml(item.id)}" aria-label="复制邮箱账号 ${escapeHtml(item.email)}">复制账号</button>
    </div>`).join('');
  const current = assignments.find((item) => item.id === selectedAccountId) || assignments[0];
  $('assignmentStatus').textContent = `${current.email}${assignments.length > 1 ? `（共 ${assignments.length} 个）` : ''}`;
  $('getCredentialsBtn').hidden = !canViewMailCredentials;
  document.querySelectorAll('[data-account-choice]').forEach((button) => {
    button.onclick = () => {
      selectedAccountId = button.dataset.accountChoice;
      renderAssignmentChoices(assignments, maxMailAccounts, assignmentPending);
    };
  });
  document.querySelectorAll('[data-copy-account]').forEach((button) => {
      button.onclick = async () => {
      if (!await accountUsageAllowed()) return;
      const account = assignments.find((item) => item.id === button.dataset.copyAccount);
      if (!account) return;
      const originalText = button.textContent;
      try {
        await copyText(account.email);
        button.textContent = '已复制';
        button.classList.add('copied');
        showResult('assignmentResult', `已复制账号：${account.email}，可直接粘贴登录`);
      } catch (error) {
        showResult('assignmentResult', error.message, false);
      } finally {
        window.setTimeout(() => {
          button.textContent = originalText;
          button.classList.remove('copied');
        }, 1600);
      }
    };
  });
}

async function checkHealth() {
  try { await api('/health', { headers: {} }); $('healthBadge').textContent = '服务在线'; $('healthBadge').className = 'badge ok'; }
  catch { $('healthBadge').textContent = '服务不可用'; $('healthBadge').className = 'badge fail'; }
}

async function loadPaymentStatus() {
  if (mode !== 'user') return;
  try {
    const data = await api('/api/payment/me');
    canViewMailCredentials = data.canViewMailCredentials === true;
    const assignments = data.assignments || (data.assignment ? [data.assignment] : []);
    renderAssignmentChoices(assignments, data.maxMailAccounts, data.assignmentPending);
    if (data.paused) $('assignmentStatus').textContent = `付费已暂停，保留 ${data.reservedAssignmentsCount || 0} 个账号`;
  } catch { $('assignmentStatus').textContent = '无法获取账号信息'; }
}

function openCredentialsConfirmModal() {
  return new Promise((resolve) => {
    const modal = $('credentialsConfirmModal');
    const confirmButton = $('confirmCredentialsBtn');
    const cancelButton = $('cancelCredentialsBtn');
    modal.hidden = false;
    const finish = (confirmed) => {
      modal.hidden = true;
      confirmButton.disabled = false;
      cancelButton.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKeyDown);
      resolve(confirmed);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKeyDown);
    confirmButton.focus();
  });
}

function renderCredentials(credential) {
  $('credentialsPanel').hidden = false;
  $('credentialsPanel').innerHTML = `<div><span>登录账号</span><strong>${escapeHtml(credential.username)}</strong></div><div><span>${escapeHtml(credential.label || '邮箱登录密码')}</span><strong id="mailCredentialPassword">${escapeHtml(credential.password)}</strong></div><button id="copyCredentialBtn" type="button">复制登录密码</button>`;
  $('copyCredentialBtn').onclick = async () => {
    try { await copyText(credential.password); showResult('assignmentResult', '登录密码已复制'); $('copyCredentialBtn').textContent = '已复制'; }
    catch (error) { showResult('assignmentResult', error.message, false); }
  };
}

$('getCredentialsBtn').onclick = async () => {
  if (!await accountUsageAllowed()) return;
  if (!canViewMailCredentials) { showResult('assignmentResult', '管理员尚未开启账号密码查看权限', false); return; }
  if (!await openCredentialsConfirmModal()) return;
  const button = $('getCredentialsBtn');
  button.disabled = true;
  button.classList.add('loading-button');
  button.textContent = '获取中…';
  try {
    const data = await api('/api/mail/credentials', { method: 'POST', body: JSON.stringify(selectedAccountId ? { accountId: selectedAccountId } : {}) });
    renderCredentials(data.credential);
    showResult('assignmentResult', '账号密码获取成功，请妥善保管');
  } catch (error) { showResult('assignmentResult', error.message, false); }
  finally { button.disabled = false; button.classList.remove('loading-button'); button.textContent = '获取账号密码'; }
};

$('requestBtn').onclick = async () => {
  if (!await accountUsageAllowed()) return;
  $('requestBtn').disabled = true;
  const confirmed = await openOtpConfirmModal();
  if (!confirmed) {
    $('requestBtn').disabled = false;
    showResult('otpResult', '已取消获取验证码');
    return;
  }
  $('cancelRequestBtn').disabled = true; $('consumeBtn').disabled = true; $('otpState').textContent = lastOtpCode ? '正在等待新的验证码…（上次验证码仍保留）' : '正在创建请求…';
  try { const data = await api('/api/otp/requests', { method: 'POST', body: JSON.stringify(selectedAccountId ? { accountId: selectedAccountId } : {}) }); requestId = data.requestId; $('cancelRequestBtn').disabled = false; $('otpState').textContent = data.resumed ? '已恢复原请求，继续等待验证码…' : (lastOtpCode ? '等待新的邮件验证码…' : '等待新邮件验证码…'); showResult('otpResult', '最长等待 5 分钟，可随时取消'); log(data.resumed ? '已恢复验证码请求' : '已创建验证码请求', data); poll(); }
  catch (error) { $('requestBtn').disabled = false; $('cancelRequestBtn').disabled = true; showResult('otpResult', error.message, false); $('otpState').textContent = '创建失败'; log('创建验证码请求失败', { error: error.message }); }
};

async function poll() {
  if (!requestId) return;
  try {
    const data = await api(`/api/otp/requests/${requestId}`);
    if (data.status === 'pending') { $('otpState').textContent = '等待新邮件验证码…'; pollTimer = setTimeout(poll, 5000); return; }
    $('cancelRequestBtn').disabled = true;
    if (data.status === 'found') { $('otpState').textContent = '已找到验证码，点击“返回并消费验证码”'; $('consumeBtn').disabled = false; showResult('otpResult', '验证码已准备好'); return; }
    $('requestBtn').disabled = false; $('otpState').textContent = data.error === 'cancelled' ? '已取消等待' : (data.status === 'expired' ? '请求已过期' : '获取失败'); showResult('otpResult', data.error === 'cancelled' ? '已取消，可在需要时重新获取' : (data.error || '未获取到验证码'), data.error === 'cancelled'); log('验证码请求结束', data);
  } catch (error) { $('requestBtn').disabled = false; $('cancelRequestBtn').disabled = true; showResult('otpResult', error.message, false); log('查询验证码状态失败', { error: error.message }); }
}

$('cancelRequestBtn').onclick = async () => {
  if (!requestId) return;
  $('cancelRequestBtn').disabled = true;
  $('cancelRequestBtn').textContent = '取消中…';
  try {
    await api(`/api/otp/requests/${requestId}/cancel`, { method: 'POST' });
    if (pollTimer) clearTimeout(pollTimer);
    $('otpState').textContent = '已取消等待';
    showResult('otpResult', '已取消，可在需要时重新获取');
    $('requestBtn').disabled = false;
    $('consumeBtn').disabled = true;
  } catch (error) { showResult('otpResult', error.message, false); }
  finally { $('cancelRequestBtn').textContent = '取消等待'; }
};

$('consumeBtn').onclick = async () => {
  $('consumeBtn').disabled = true;
  try { const data = await api(`/api/otp/requests/${requestId}/consume`, { method: 'POST' }); renderOtpCode(data.code); $('otpState').textContent = '验证码已消费，仅显示本次结果'; showResult('otpResult', '验证码返回成功'); log('验证码消费成功'); }
  catch (error) { showResult('otpResult', error.message, false); log('消费验证码失败', { error: error.message }); }
  finally { $('requestBtn').disabled = false; }
};

$('toggleOtpVisibilityBtn').onclick = () => {
  otpVisible = !otpVisible;
  $('otpCode').classList.toggle('is-hidden', !otpVisible && Boolean(lastOtpCode));
  $('toggleOtpVisibilityBtn').textContent = otpVisible ? '隐藏验证码' : '显示验证码';
};

if ($('createPaymentBtn')) $('createPaymentBtn').onclick = async () => {
  if (!selectedPlanId) { showResult('paymentResult', '暂无可购买套餐，请联系管理员配置', false); return; }
  const plan = paymentPlans.find((item) => item.id === selectedPlanId);
  if (!plan) { showResult('paymentResult', '套餐不存在，请刷新后重试', false); return; }
  const confirmed = await openPaymentConfirmModal(plan);
  if (!confirmed) {
    showResult('paymentResult', '已取消创建订单');
    return;
  }
  const createButton = $('createPaymentBtn');
  createButton.disabled = true;
  createButton.classList.add('loading-button');
  createButton.textContent = '创建中…';
  try {
    const data = await api('/api/payment/orders', { method: 'POST', body: JSON.stringify({ planId: selectedPlanId }) });
    paymentOrderId = data.order.id;
    const createdPlan = paymentPlans.find((item) => item.id === data.order.planId);
    showResult('paymentResult', `已创建${createdPlan ? `「${createdPlan.name}」` : ''}订单，正在跳转支付…`); log('创建真实支付订单', data.order);
    if (data.paymentUrl) window.location.assign(data.paymentUrl);
  } catch (error) { showResult('paymentResult', error.message, false); }
  finally { createButton.disabled = false; createButton.classList.remove('loading-button'); createButton.textContent = '立即支付'; }
};

checkHealth();
loadPaymentStatus();
loadAnnouncements();

if (!window.authStorage.getToken()) {
  window.setTimeout(() => window.location.replace('/auth.html'), 0);
}

async function loadAuthStatus() {
  const token = window.authStorage.getToken();
  if (!token) return;
  try {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录已失效');
    $('authUserLabel').textContent = `${data.user.id}${data.user.role === 'admin' ? ' · 管理员' : ''}`;
    $('adminTab')?.setAttribute('hidden', '');
    $('userTab')?.setAttribute('hidden', '');
    $('userPageNav').hidden = data.user.role === 'admin';
    $('authLoginLink').hidden = true;
    $('profileLink').hidden = false;
    $('authLogoutBtn').hidden = false;
    $('authLogoutBtn').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); window.authStorage.clearToken(); location.reload(); };
    if (data.user.role === 'admin') { window.location.replace('/admin-users.html'); return; }
  } catch { window.authStorage.clearToken(); }
}
loadAuthStatus();

function switchMode(next) {
  mode = next;
  $('userView').hidden = next !== 'user';
  $('adminView').hidden = next !== 'admin';
  $('userPageNav').hidden = next === 'admin';
  $('userTab').classList.toggle('active', next === 'user');
  $('adminTab').classList.toggle('active', next === 'admin');
  if (next !== 'admin') loadPaymentStatus();
}

if ($('userTab')) $('userTab').onclick = () => switchMode('user');
if ($('adminTab')) $('adminTab').onclick = () => switchMode('admin');

async function loadAdmin() {
  try {
    const [data, accountData] = await Promise.all([api('/api/admin/overview'), api('/api/admin/mail-accounts')]);
    managedAccounts = accountData.accounts;
    renderManagedAccounts(managedAccounts);
    $('userRows').innerHTML = data.users.map((user) => `
      <tr>
        <td>${escapeHtml(user.id)}</td>
        <td>${user.role === 'admin' ? '管理员' : '用户'}</td>
        <td><span class="status-pill ${user.paid ? 'yes' : (user.paidUntil ? 'paused' : 'no')}">${user.paid ? '已付费' : (user.paidUntil ? '已暂停' : '未开通')}</span>${user.role === 'user' ? `<div class="expiry-control"><input type="datetime-local" value="${formatDateTimeInput(user.paidUntil)}" data-expiry-user="${encodeURIComponent(user.id)}"><button class="table-action" data-save-expiry="${encodeURIComponent(user.id)}">保存日期</button></div>` : ''}</td>
        <td>${user.role === 'admin' ? '—' : `<div class="limit-control"><input type="number" min="1" max="20" value="${user.maxMailAccounts || 1}" data-limit-user="${encodeURIComponent(user.id)}"><button class="table-action" data-save-limit="${encodeURIComponent(user.id)}">保存</button></div>`}</td>
        <td>${user.assignments?.length ? user.assignments.map((item) => `<div class="assigned-row"><span>${escapeHtml(item.email)}${item.source === 'admin' ? ' · 指定' : ' · 随机'}</span><button class="table-action danger" data-unassign-user="${encodeURIComponent(user.id)}" data-unassign-account="${encodeURIComponent(item.id)}">解绑</button></div>`).join('') : '未分配'}${user.role === 'user' && user.paid ? `<div class="assignment-actions"><button class="table-action" data-auto-assign="${encodeURIComponent(user.id)}">随机追加</button><select data-assign-select="${encodeURIComponent(user.id)}"><option value="">指定账号…</option>${managedAccounts.filter((account) => account.active && !(user.assignments || []).some((item) => item.id === account.id)).map((account) => `<option value="${account.id}">${escapeHtml(account.email)}</option>`).join('')}</select><button class="table-action" data-admin-assign="${encodeURIComponent(user.id)}">指定</button></div>` : ''}</td>
        <td>${user.requestCount}</td>
        <td>${user.role === 'admin' ? '—' : `<button class="table-action" data-subscription-user="${encodeURIComponent(user.id)}" data-subscription-action="${user.paid ? 'pause' : (user.paidUntil ? 'restore' : 'activate')}" data-current-expiry="${user.paidUntil || ''}">${user.paid ? '暂停付费' : (user.paidUntil ? '恢复付费' : '开通付费')}</button>`}</td>
      </tr>`).join('');
    document.querySelectorAll('[data-subscription-user]').forEach((button) => button.onclick = () => updateSubscription(decodeURIComponent(button.dataset.subscriptionUser), button.dataset.subscriptionAction, Number(button.dataset.currentExpiry) || undefined));
    document.querySelectorAll('[data-save-expiry]').forEach((button) => button.onclick = () => updateExpiry(decodeURIComponent(button.dataset.saveExpiry)));
    document.querySelectorAll('[data-save-limit]').forEach((button) => button.onclick = () => updateMailLimit(decodeURIComponent(button.dataset.saveLimit)));
    document.querySelectorAll('[data-auto-assign]').forEach((button) => button.onclick = () => assignAccount(decodeURIComponent(button.dataset.autoAssign)));
    document.querySelectorAll('[data-admin-assign]').forEach((button) => button.onclick = () => {
      const userId = decodeURIComponent(button.dataset.adminAssign);
      const select = document.querySelector(`[data-assign-select="${encodeURIComponent(userId)}"]`);
      if (!select?.value) { showResult('adminResult', '请先选择要指定的邮箱账号', false); return; }
      assignAccount(userId, select.value);
    });
    document.querySelectorAll('[data-unassign-user]').forEach((button) => button.onclick = () => unassignAccount(decodeURIComponent(button.dataset.unassignUser), decodeURIComponent(button.dataset.unassignAccount)));
    log('管理员列表已刷新', { users: data.users.length });
  } catch (error) { showResult('adminResult', error.message, false); }
}

async function loadManagedAccounts() {
  try {
    const data = await api('/api/admin/mail-accounts');
    managedAccounts = data.accounts;
    renderManagedAccounts(managedAccounts);
  } catch (error) { showResult('accountResult', error.message, false); }
}

function renderManagedAccounts(accounts) {
    $('accountRows').innerHTML = accounts.length ? accounts.map((account) => `
      <tr><td>${escapeHtml(account.email)}</td><td>${account.assignedUsers} / ${account.maxUsers}</td><td><span class="status-pill ${account.active ? 'yes' : 'no'}">${account.active ? '启用' : '停用'}</span></td><td><button class="table-action" data-account="${account.id}" data-active="${!account.active}">${account.active ? '停用' : '启用'}</button></td></tr>`).join('') : '<tr><td colspan="4">还没有管理员账号</td></tr>';
    document.querySelectorAll('[data-account]').forEach((button) => button.onclick = () => updateManagedAccount(button.dataset.account, button.dataset.active === 'true'));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function updateSubscription(userId, action, currentExpiry) {
  if (action === 'pause' && !window.confirm(`确认暂停 ${userId} 的付费权限？\n当前到期时间：${formatExpiry(currentExpiry)}\n恢复时仍使用这个到期时间。`)) return;
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/subscription`, { method: 'PATCH', body: JSON.stringify({ action }) }); showResult('adminResult', action === 'pause' ? `已暂停 ${userId}，原到期时间已保留` : (action === 'restore' ? `已恢复 ${userId}，沿用原到期时间` : `已为 ${userId} 开通 30 天`)); await loadAdmin(); }
  catch (error) { showResult('adminResult', error.message, false); }
}

async function updateExpiry(userId) {
  const input = document.querySelector(`[data-expiry-user="${encodeURIComponent(userId)}"]`);
  const paidUntil = input?.value ? new Date(input.value).getTime() : NaN;
  if (!Number.isFinite(paidUntil)) { showResult('adminResult', '请选择具体的到期日期和时间', false); return; }
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/expiry`, { method: 'PATCH', body: JSON.stringify({ paidUntil }) }); showResult('adminResult', `已将 ${userId} 的到期时间设置为 ${formatExpiry(paidUntil)}`); await loadAdmin(); }
  catch (error) { showResult('adminResult', error.message, false); }
}

async function updateMailLimit(userId) {
  const input = document.querySelector(`[data-limit-user="${encodeURIComponent(userId)}"]`);
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-limit`, { method: 'PATCH', body: JSON.stringify({ maxMailAccounts: Number(input.value) }) }); showResult('adminResult', `已更新 ${userId} 的账号数量权限`); await loadAdmin(); }
  catch (error) { showResult('adminResult', error.message, false); }
}

async function assignAccount(userId, accountId = '') {
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-accounts`, { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}) }); showResult('adminResult', `已为 ${userId} 分配账号`); await loadAdmin(); }
  catch (error) { showResult('adminResult', error.message, false); }
}

async function unassignAccount(userId, accountId) {
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }); showResult('adminResult', `已解绑 ${userId} 的账号`); await loadAdmin(); }
  catch (error) { showResult('adminResult', error.message, false); }
}

$('createUserBtn').onclick = async () => {
  try {
    const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ userId: $('newUserId').value.trim(), paid: $('newUserPaid').checked }) });
    showResult('adminResult', `用户 ${data.user.id} 创建成功`); $('newUserId').value = ''; await loadAdmin();
  } catch (error) { showResult('adminResult', error.message, false); }
};

$('refreshAdminBtn').onclick = loadAdmin;
$('refreshAccountsBtn').onclick = loadAdmin;
$('addManagedBtn').onclick = async () => {
  try {
    const data = await api('/api/admin/mail-accounts', { method: 'POST', body: JSON.stringify({ email: $('managedEmail').value.trim(), appPassword: $('managedPassword').value, maxUsers: Number($('managedMaxUsers').value) }) });
    showResult('accountResult', `账号已加入资源池：${data.email}，上限 ${data.maxUsers} 人`); $('managedPassword').value = ''; await loadAdmin();
  } catch (error) { showResult('accountResult', error.message, false); }
};

async function updateManagedAccount(id, active) {
  try { await api(`/api/admin/mail-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active }) }); await loadAdmin(); }
  catch (error) { showResult('accountResult', error.message, false); }
}
