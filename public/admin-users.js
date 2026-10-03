const $ = (id) => document.getElementById(id);
let managedAccounts = [];
let primaryAdmin = false;
let passwordResetUserId = '';
let passwordResetMode = 'user';

function headers(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function showResult(message, ok = true) {
  $('adminResult').textContent = message;
  $('adminResult').className = `result ${ok ? 'success' : 'error'}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

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

function applyUserSearch() {
  const keyword = $('userSearchInput').value.trim().toLowerCase();
  const cards = [...document.querySelectorAll('.user-card')];
  let visibleCount = 0;
  for (const card of cards) {
    const matched = !keyword || card.dataset.search.includes(keyword);
    card.hidden = !matched;
    if (matched) visibleCount += 1;
  }
  $('userSearchCount').textContent = keyword ? `找到 ${visibleCount} / ${cards.length} 个用户` : `共 ${cards.length} 个用户`;
  $('userSearchEmpty').hidden = visibleCount > 0 || cards.length === 0;
}

async function loadUsers() {
  try {
    primaryAdmin = window.currentAdmin?.adminLevel === 'primary';
    const paidToggle = $('newUserPaid')?.closest('label');
    if (paidToggle) paidToggle.hidden = !primaryAdmin;
    const createHint = document.querySelector('.admin-create-hint');
    if (createHint) createHint.textContent = primaryAdmin ? '新用户默认只有 1 个邮箱账号权限。' : '次级管理员可以创建普通用户，但不能开通订阅。';
    const [overview, accountData] = await Promise.all([api('/api/admin/overview'), api('/api/admin/mail-accounts')]);
    managedAccounts = accountData.accounts;
    $('userRows').innerHTML = overview.users.map((user) => {
      const userKey = encodeURIComponent(user.id);
      const secondaryAdmin = user.role === 'admin' && user.adminLevel === 'secondary';
      const primaryAccount = user.role === 'admin' && user.adminLevel === 'primary';
      const statusClass = user.role === 'admin' ? (user.adminActive === false ? 'no' : 'yes') : (user.paid ? 'yes' : (user.paidUntil ? 'paused' : 'no'));
      const statusText = user.role === 'admin' ? (user.adminActive === false ? '已停用' : '正常') : (user.paid ? '已付费' : (user.paidUntil ? '已暂停' : '未开通'));
      const assignments = user.assignments?.length
        ? user.assignments.map((item) => `<div class="assigned-row"><div><strong>${escapeHtml(item.email)}</strong><small>${item.source === 'admin' ? '管理员指定' : '随机分配'}</small></div><button class="table-action danger" data-unassign-user="${userKey}" data-unassign-account="${encodeURIComponent(item.id)}">解绑</button></div>`).join('')
        : '<div class="empty-inline">未分配账号</div>';
      const assignActions = user.role === 'user' && user.paid ? `<div class="assignment-actions"><button class="table-action" data-auto-assign="${userKey}">随机追加</button><select data-assign-select="${userKey}"><option value="">指定账号…</option>${managedAccounts.filter((account) => account.active && !(user.assignments || []).some((item) => item.id === account.id)).map((account) => `<option value="${account.id}">${escapeHtml(account.email)}</option>`).join('')}</select><button class="table-action" data-admin-assign="${userKey}">指定</button></div>` : '';
      const subscriptionAction = user.paid ? 'pause' : (user.paidUntil ? 'restore' : 'activate');
      const subscriptionText = user.paid ? '暂停付费' : (user.paidUntil ? '恢复付费' : '开通付费');
      const searchText = [user.id, ...(user.assignments || []).flatMap((item) => [item.id, item.email])].join(' ').toLowerCase();
      return `<article class="user-card" data-search="${escapeHtml(searchText)}">
        <div class="user-card-head"><div><h3>${escapeHtml(user.id)}</h3><span class="role-label">${primaryAccount ? '主管理员' : (secondaryAdmin ? '次级管理员' : '普通用户')}</span></div><span class="status-pill ${statusClass}">${statusText}</span></div>
        <div class="user-card-grid">
          <section class="user-card-section"><h4>订阅设置</h4>${user.role === 'user' && primaryAdmin ? `<div class="expiry-control"><input type="datetime-local" value="${formatDateTimeInput(user.paidUntil)}" data-expiry-user="${userKey}"><button class="table-action" data-save-expiry="${userKey}">保存日期</button></div>` : (user.role === 'user' ? '<div class="empty-inline">订阅由主管理员管理</div>' : '<div class="empty-inline">管理员不受订阅日期限制</div>')}<div class="user-meta">验证码请求数：${user.requestCount}</div></section>
          <section class="user-card-section"><h4>账号权限</h4>${user.role === 'admin' ? '<div class="empty-inline">不适用</div>' : `<div class="limit-control"><input type="number" min="1" max="20" value="${user.maxMailAccounts || 1}" data-limit-user="${userKey}"><button class="table-action" data-save-limit="${userKey}">保存上限</button></div><button class="table-action credential-permission-btn" data-credentials-user="${userKey}" data-credentials-enabled="${user.canViewMailCredentials === true}">${user.canViewMailCredentials ? '已允许查看密码' : '允许查看密码'}</button>`}</section>
          <section class="user-card-section user-card-accounts"><h4>已分配账号 <span>${user.assignments?.length || 0} / ${user.maxMailAccounts || '—'}</span></h4>${assignments}${assignActions}</section>
        </div>
        <div class="user-card-actions">${primaryAccount ? '<span class="empty-inline">主管理员账号受保护</span>' : (secondaryAdmin ? (primaryAdmin ? `<button class="table-action primary-action" data-toggle-secondary-admin="${userKey}" data-admin-active="${user.adminActive !== false}">${user.adminActive === false ? '启用管理员' : '停用管理员'}</button><button class="table-action" data-reset-secondary-admin="${userKey}">重置密码</button><button class="table-action danger" data-delete-secondary-admin="${userKey}">删除次级管理员</button>` : '<span class="empty-inline">次级管理员由主管理员维护</span>') : `${primaryAdmin ? `<button class="table-action primary-action" data-subscription-user="${userKey}" data-subscription-action="${subscriptionAction}" data-current-expiry="${user.paidUntil || ''}">${subscriptionText}</button>` : ''}<button class="table-action" data-reset-password-user="${userKey}">重置密码</button><button class="table-action danger" data-delete-user="${userKey}">删除用户</button>`)}</div>
      </article>`;
    }).join('');

    document.querySelectorAll('[data-subscription-user]').forEach((button) => button.onclick = () => updateSubscription(decodeURIComponent(button.dataset.subscriptionUser), button.dataset.subscriptionAction, Number(button.dataset.currentExpiry) || undefined));
    document.querySelectorAll('[data-save-expiry]').forEach((button) => button.onclick = () => updateExpiry(decodeURIComponent(button.dataset.saveExpiry)));
    document.querySelectorAll('[data-save-limit]').forEach((button) => button.onclick = () => updateMailLimit(decodeURIComponent(button.dataset.saveLimit)));
    document.querySelectorAll('[data-credentials-user]').forEach((button) => button.onclick = () => updateCredentialPermission(decodeURIComponent(button.dataset.credentialsUser), button.dataset.credentialsEnabled !== 'true'));
    document.querySelectorAll('[data-auto-assign]').forEach((button) => button.onclick = () => assignAccount(decodeURIComponent(button.dataset.autoAssign)));
    document.querySelectorAll('[data-admin-assign]').forEach((button) => button.onclick = () => {
      const userId = decodeURIComponent(button.dataset.adminAssign);
      const select = document.querySelector(`[data-assign-select="${encodeURIComponent(userId)}"]`);
      if (!select?.value) { showResult('请先选择要指定的邮箱账号', false); return; }
      assignAccount(userId, select.value);
    });
    document.querySelectorAll('[data-unassign-user]').forEach((button) => button.onclick = () => unassignAccount(decodeURIComponent(button.dataset.unassignUser), decodeURIComponent(button.dataset.unassignAccount)));
    document.querySelectorAll('[data-reset-password-user]').forEach((button) => button.onclick = () => resetUserPassword(decodeURIComponent(button.dataset.resetPasswordUser)));
    document.querySelectorAll('[data-delete-user]').forEach((button) => button.onclick = () => deleteUser(decodeURIComponent(button.dataset.deleteUser)));
    document.querySelectorAll('[data-toggle-secondary-admin]').forEach((button) => button.onclick = () => toggleSecondaryAdmin(decodeURIComponent(button.dataset.toggleSecondaryAdmin), button.dataset.adminActive !== 'true'));
    document.querySelectorAll('[data-reset-secondary-admin]').forEach((button) => button.onclick = () => resetSecondaryAdminPassword(decodeURIComponent(button.dataset.resetSecondaryAdmin)));
    document.querySelectorAll('[data-delete-secondary-admin]').forEach((button) => button.onclick = () => deleteSecondaryAdmin(decodeURIComponent(button.dataset.deleteSecondaryAdmin)));
    applyUserSearch();
  } catch (error) { showResult(error.message, false); }
}

async function updateCredentialPermission(userId, enabled) {
  const actionText = enabled ? '开启' : '关闭';
  if (!window.confirm(`确认${actionText} ${userId} 的账号密码查看权限吗？\n开启后，用户可以查看已分配邮箱的登录账号和客户端授权码。`)) return;
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-credentials`, { method: 'PATCH', body: JSON.stringify({ enabled }) }); showResult(`${userId} 的账号密码查看权限已${enabled ? '开启' : '关闭'}`); await loadUsers(); }
  catch (error) { showResult(error.message, false); }
}

async function updateSubscription(userId, action, currentExpiry) {
  if (action === 'pause' && !window.confirm(`确认暂停 ${userId} 的付费权限？\n当前到期时间：${formatExpiry(currentExpiry)}\n恢复时仍使用这个到期时间。`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/subscription`, { method: 'PATCH', body: JSON.stringify({ action }) });
    showResult(action === 'pause' ? `已暂停 ${userId}，原到期时间已保留` : (action === 'restore' ? `已恢复 ${userId}，沿用原到期时间` : `已为 ${userId} 开通 30 天`));
    await loadUsers();
  } catch (error) { showResult(error.message, false); }
}

async function updateExpiry(userId) {
  const input = document.querySelector(`[data-expiry-user="${encodeURIComponent(userId)}"]`);
  const paidUntil = input?.value ? new Date(input.value).getTime() : NaN;
  if (!Number.isFinite(paidUntil)) { showResult('请选择具体的到期日期和时间', false); return; }
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/expiry`, { method: 'PATCH', body: JSON.stringify({ paidUntil }) }); showResult(`已将 ${userId} 的到期时间设置为 ${formatExpiry(paidUntil)}`); await loadUsers(); }
  catch (error) { showResult(error.message, false); }
}

async function updateMailLimit(userId) {
  const input = document.querySelector(`[data-limit-user="${encodeURIComponent(userId)}"]`);
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-limit`, { method: 'PATCH', body: JSON.stringify({ maxMailAccounts: Number(input.value) }) }); showResult(`已更新 ${userId} 的账号数量权限`); await loadUsers(); }
  catch (error) { showResult(error.message, false); }
}

async function assignAccount(userId, accountId = '') {
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-accounts`, { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}) }); showResult(`已为 ${userId} 分配账号`); await loadUsers(); }
  catch (error) { showResult(error.message, false); }
}

async function unassignAccount(userId, accountId) {
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/mail-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }); showResult(`已解绑 ${userId} 的账号`); await loadUsers(); }
  catch (error) { showResult(error.message, false); }
}

async function resetUserPassword(userId) {
  openPasswordReset(userId, 'user');
}

function openPasswordReset(userId, mode) {
  passwordResetUserId = userId;
  passwordResetMode = mode;
  const secondaryAdmin = mode === 'secondary-admin';
  $('userPasswordResetTitle').textContent = secondaryAdmin ? '重置次级管理员密码' : '重置用户密码';
  $('userPasswordResetAccount').textContent = userId;
  $('userPasswordResetDescription').innerHTML = `正在为 <strong>${escapeHtml(userId)}</strong> 设置新的登录密码。提交后该账号的所有旧登录会话会立即失效。`;
  $('userResetAdminPasswordField').hidden = secondaryAdmin;
  $('userResetConfirmationField').hidden = secondaryAdmin;
  $('userResetPassword').value = '';
  $('userResetConfirmPassword').value = '';
  $('userResetAdminPassword').value = '';
  $('userResetConfirmation').value = '';
  $('userPasswordResetResult').textContent = '';
  $('userPasswordResetResult').className = 'result';
  $('userPasswordResetModal').hidden = false;
  setTimeout(() => $('userResetPassword').focus(), 0);
}

function closeUserPasswordReset() {
  passwordResetUserId = '';
  passwordResetMode = 'user';
  $('userPasswordResetModal').hidden = true;
  $('userResetPassword').value = '';
  $('userResetConfirmPassword').value = '';
  $('userResetAdminPassword').value = '';
  $('userResetConfirmation').value = '';
}

async function submitUserPasswordReset() {
  if (!passwordResetUserId) return;
  const password = $('userResetPassword').value;
  const confirmPassword = $('userResetConfirmPassword').value;
  const adminPassword = $('userResetAdminPassword').value;
  const confirmation = $('userResetConfirmation').value.trim();
  const secondaryAdmin = passwordResetMode === 'secondary-admin';
  const result = $('userPasswordResetResult');
  if (!password || !confirmPassword || (!secondaryAdmin && !adminPassword)) {
    result.textContent = secondaryAdmin ? '请完整填写新密码和确认密码' : '请完整填写新密码、确认密码和当前管理员密码';
    result.className = 'result error';
    return;
  }
  if (password !== confirmPassword) {
    result.textContent = '两次输入的新密码不一致';
    result.className = 'result error';
    return;
  }
  if (!secondaryAdmin && confirmation !== '确认重置') {
    result.textContent = '请输入正确的确认词：确认重置';
    result.className = 'result error';
    return;
  }
  const button = $('submitUserPasswordReset');
  button.disabled = true;
  button.textContent = '正在重置…';
  try {
    const userId = passwordResetUserId;
    const url = secondaryAdmin
      ? `/api/admin/administrators/${encodeURIComponent(userId)}/password`
      : `/api/admin/users/${encodeURIComponent(userId)}/password`;
    const body = secondaryAdmin ? { password, confirmPassword } : { password, confirmPassword, adminPassword, confirmation };
    await api(url, { method: 'PATCH', body: JSON.stringify(body) });
    closeUserPasswordReset();
    showResult(`${secondaryAdmin ? '次级管理员' : '用户'} ${userId} 的密码已重置，原登录会话已失效`);
  } catch (error) {
    result.textContent = error.message;
    result.className = 'result error';
  } finally {
    button.disabled = false;
    button.textContent = '确认重置密码';
  }
}

async function toggleSecondaryAdmin(userId, active) {
  if (!window.confirm(`确认${active ? '启用' : '停用'}次级管理员 ${userId} 吗？${active ? '' : '\n停用后，该账号现有登录会话会立即失效。'}`)) return;
  try {
    await api(`/api/admin/administrators/${encodeURIComponent(userId)}/status`, { method: 'PATCH', body: JSON.stringify({ active }) });
    showResult(`次级管理员 ${userId} 已${active ? '启用' : '停用'}`);
    await loadUsers();
  } catch (error) { showResult(error.message, false); }
}

async function resetSecondaryAdminPassword(userId) {
  openPasswordReset(userId, 'secondary-admin');
}

async function deleteSecondaryAdmin(userId) {
  if (!window.confirm(`确认删除次级管理员 ${userId} 吗？此操作不可恢复。`)) return;
  const adminPassword = window.prompt('请输入当前主管理员密码确认删除：');
  if (adminPassword === null) return;
  try {
    await api(`/api/admin/administrators/${encodeURIComponent(userId)}`, { method: 'DELETE', body: JSON.stringify({ adminPassword }) });
    showResult(`次级管理员 ${userId} 已删除`);
    await loadUsers();
  } catch (error) { showResult(error.message, false); }
}

async function deleteUser(userId) {
  if (!window.confirm(`确认删除用户 ${userId} 吗？\n删除后会清理该用户的订阅、订单、邮箱绑定、验证码请求、客服工单和登录会话，此操作不可恢复。`)) return;
  const adminPassword = window.prompt('请输入当前管理员登录密码以确认删除：');
  if (adminPassword === null) return;
  if (!adminPassword) { showResult('未输入管理员密码，已取消删除', false); return; }
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', body: JSON.stringify({ adminPassword }) });
    showResult(`用户 ${userId} 已删除`);
    await loadUsers();
  } catch (error) { showResult(error.message, false); }
}

$('createUserBtn').onclick = async () => {
  try {
    const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ userId: $('newUserId').value.trim(), paid: primaryAdmin && $('newUserPaid').checked }) });
    showResult(`用户 ${data.user.id} 创建成功`);
    $('newUserId').value = '';
    await loadUsers();
  } catch (error) { showResult(error.message, false); }
};

$('refreshAdminBtn').onclick = loadUsers;
$('searchUserBtn').onclick = applyUserSearch;
$('userSearchInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  applyUserSearch();
});
$('clearUserSearchBtn').onclick = () => {
  $('userSearchInput').value = '';
  applyUserSearch();
  $('userSearchInput').focus();
};
$('cancelUserPasswordReset').onclick = closeUserPasswordReset;
$('submitUserPasswordReset').onclick = submitUserPasswordReset;
$('userPasswordResetModal').onclick = (event) => { if (event.target === $('userPasswordResetModal')) closeUserPasswordReset(); };
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('userPasswordResetModal').hidden) closeUserPasswordReset();
});
window.adminAuthReady?.then(() => loadUsers());
