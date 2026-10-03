const $ = (id) => document.getElementById(id);
let testedAccountToken = null;
const accountConnectionStates = new Map();

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
  $('accountResult').textContent = message;
  $('accountResult').className = `result ${ok ? 'success' : 'error'}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function resetAccountTest(message = '账号信息有变化，请重新测试连接。') {
  testedAccountToken = null;
  $('addManagedBtn').disabled = true;
  $('accountTestState').textContent = message;
  $('accountTestState').className = 'account-test-state';
}

function formatDateTimeInput(value) {
  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function expiryView(expiresAt) {
  const remaining = expiresAt - Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (remaining <= 0) {
    const overdueDays = Math.floor(Math.abs(remaining) / dayMs);
    const text = overdueDays < 1 ? '已过期不足1天' : `已过期 ${overdueDays} 天`;
    return { rowClass: 'account-expired', badgeClass: 'expired', text, state: 'expired' };
  }
  const days = Math.ceil(remaining / dayMs);
  if (remaining <= 7 * dayMs) {
    return { rowClass: 'account-expiring', badgeClass: 'warning', text: `即将到期 · 剩余 ${days} 天`, state: 'expiring' };
  }
  return { rowClass: '', badgeClass: 'safe', text: `剩余 ${days} 天`, state: 'safe' };
}

function updateSelectionUi() {
  const selected = [...document.querySelectorAll('[data-select-account]:checked')];
  $('selectedAccountCount').textContent = `已选择 ${selected.length} 个账号`;
  $('batchUpdateBtn').disabled = selected.length === 0;
  const all = document.querySelectorAll('[data-select-account]');
  $('selectAllAccounts').checked = all.length > 0 && selected.length === all.length;
  $('selectAllAccounts').indeterminate = selected.length > 0 && selected.length < all.length;
}

function setConnectionState(id, state, message) {
  accountConnectionStates.set(id, state);
  const target = document.querySelector(`[data-connection-state="${id}"]`);
  if (!target) return;
  target.textContent = message;
  target.className = `account-connection-state ${state}`;
}

async function testManagedAccount(id, button) {
  button.disabled = true;
  setConnectionState(id, 'testing', '测试中…');
  try {
    await api(`/api/admin/mail-accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
    setConnectionState(id, 'success', '连接成功');
    showResult('邮箱连接成功');
  } catch (error) {
    setConnectionState(id, 'failed', '连接失败');
    showResult(error.message, false);
  } finally {
    button.disabled = false;
  }
}

async function showAccountCredentials(id) {
  try {
    const data = await api(`/api/admin/mail-accounts/${encodeURIComponent(id)}/credentials`, { method: 'POST' });
    const credentials = data.credentials;
    $('credentialEmail').value = credentials.email || '';
    $('credentialAppPassword').value = credentials.appPassword || '';
    $('credentialLoginPassword').value = credentials.loginPassword || '';
    $('credentialLoginPasswordEmpty').hidden = Boolean(credentials.loginPassword);
    ['credentialAppPassword', 'credentialLoginPassword'].forEach((fieldId) => { $(fieldId).type = 'password'; });
    document.querySelectorAll('[data-toggle-credential]').forEach((button) => { button.textContent = '显示'; });
    $('credentialModal').hidden = false;
  } catch (error) { showResult(error.message, false); }
}

function closeCredentialModal() {
  $('credentialModal').hidden = true;
  $('credentialEmail').value = '';
  $('credentialAppPassword').value = '';
  $('credentialLoginPassword').value = '';
}

async function loadAccounts() {
  try {
    const canViewCredentials = window.currentAdmin?.adminLevel === 'primary';
    const data = await api('/api/admin/mail-accounts');
    const expiryStates = data.accounts.map((account) => expiryView(account.expiresAt));
    const expiredCount = expiryStates.filter((item) => item.state === 'expired').length;
    const expiringCount = expiryStates.filter((item) => item.state === 'expiring').length;
    const safeCount = expiryStates.filter((item) => item.state === 'safe').length;
    $('accountExpirySummary').className = `account-expiry-summary ${expiredCount ? 'has-expired' : (expiringCount ? 'has-warning' : '')}`;
    $('accountExpirySummary').innerHTML = `<strong>账号周期统计</strong><span>正常 ${safeCount}</span><span>7天内到期 ${expiringCount}</span><span>已过期 ${expiredCount}</span>`;
    $('accountRows').innerHTML = data.accounts.length ? data.accounts.map((account) => {
      const expiry = expiryView(account.expiresAt);
      const connectionState = accountConnectionStates.get(account.id);
      return `
      <tr class="${expiry.rowClass}" data-account-row="${account.id}">
        <td><input class="account-select" type="checkbox" data-select-account="${account.id}"></td>
        <td><div class="account-identity"><strong>${escapeHtml(account.email)}</strong><small>${account.note ? escapeHtml(account.note) : '暂无备注'}</small></div></td>
        <td>${account.assignedUsers}</td>
        <td><div class="limit-control"><input type="number" min="1" max="1000" value="${account.maxUsers}" data-account-max="${account.id}"><button class="table-action" data-save-account-max="${account.id}">保存</button></div></td>
        <td><div class="account-expiry-control"><input type="datetime-local" value="${formatDateTimeInput(account.expiresAt)}" data-account-expiry="${account.id}"><button class="table-action" data-save-account-expiry="${account.id}">保存日期</button><span class="expiry-badge ${expiry.badgeClass}">${expiry.text}</span></div></td>
        <td><div class="account-status-cell"><span class="status-pill ${account.active ? 'yes' : 'no'}">${account.active ? '启用' : '停用'}</span><span class="account-connection-state ${connectionState || ''}" data-connection-state="${account.id}">${connectionState === 'success' ? '连接成功' : connectionState === 'failed' ? '连接失败' : connectionState === 'testing' ? '测试中…' : '未测试'}</span></div></td>
        <td><div class="account-row-actions">${canViewCredentials ? `<button class="table-action credential-action" data-view-credentials="${account.id}">查看密码</button>` : ''}<button class="table-action" data-test-account="${account.id}">测试连接</button><button class="table-action" data-edit-account="${account.id}">修改</button><button class="table-action renew-action" data-renew-account="${account.id}">续费30天</button><button class="table-action" data-account="${account.id}" data-active="${!account.active}">${account.active ? '停用' : '启用'}</button><button class="table-action danger-action" data-delete-account="${account.id}" data-email="${escapeHtml(account.email)}">删除</button></div></td>
      </tr>
      <tr class="account-edit-row" data-edit-row="${account.id}" hidden><td colspan="7"><div class="account-edit-panel ${canViewCredentials ? '' : 'secondary-edit-panel'}"><label>邮箱<input type="email" value="${escapeHtml(account.email)}" data-edit-email="${account.id}"></label>${canViewCredentials ? `<label>新客户端授权码<input type="password" placeholder="留空表示不修改" autocomplete="new-password" data-edit-password="${account.id}"></label><label>邮箱登录密码<input type="password" placeholder="留空表示不修改" autocomplete="new-password" data-edit-login-password="${account.id}"></label>` : ''}<label>备注<input type="text" maxlength="200" value="${escapeHtml(account.note || '')}" data-edit-note="${account.id}"></label><div class="account-edit-actions"><button class="table-action primary-action" data-save-edit="${account.id}">保存修改</button><button class="table-action" data-cancel-edit="${account.id}">取消</button></div></div></td></tr>`;
    }).join('') : '<tr><td colspan="7">还没有管理员账号</td></tr>';
    document.querySelectorAll('[data-select-account]').forEach((checkbox) => checkbox.onchange = updateSelectionUi);
    $('selectAllAccounts').onchange = () => {
      document.querySelectorAll('[data-select-account]').forEach((checkbox) => { checkbox.checked = $('selectAllAccounts').checked; });
      updateSelectionUi();
    };
    updateSelectionUi();
    document.querySelectorAll('[data-account]').forEach((button) => button.onclick = () => updateAccount(button.dataset.account, { active: button.dataset.active === 'true' }));
    document.querySelectorAll('[data-save-account-max]').forEach((button) => button.onclick = () => {
      const id = button.dataset.saveAccountMax;
      const input = document.querySelector(`[data-account-max="${id}"]`);
      updateAccount(id, { maxUsers: Number(input.value) });
    });
    document.querySelectorAll('[data-save-account-expiry]').forEach((button) => button.onclick = () => {
      const id = button.dataset.saveAccountExpiry;
      const input = document.querySelector(`[data-account-expiry="${id}"]`);
      const expiresAt = input?.value ? new Date(input.value).getTime() : NaN;
      if (!Number.isFinite(expiresAt)) { showResult('请选择具体的到期日期和时间', false); return; }
      updateAccount(id, { expiresAt }, '账号到期时间已更新');
    });
    document.querySelectorAll('[data-renew-account]').forEach((button) => button.onclick = () => updateAccount(button.dataset.renewAccount, { renewDays: 30 }, '账号已续费30天'));
    document.querySelectorAll('[data-test-account]').forEach((button) => button.onclick = () => testManagedAccount(button.dataset.testAccount, button));
    document.querySelectorAll('[data-view-credentials]').forEach((button) => button.onclick = () => showAccountCredentials(button.dataset.viewCredentials));
    document.querySelectorAll('[data-edit-account]').forEach((button) => button.onclick = () => {
      const row = document.querySelector(`[data-edit-row="${button.dataset.editAccount}"]`);
      row.hidden = !row.hidden;
    });
    document.querySelectorAll('[data-cancel-edit]').forEach((button) => button.onclick = () => {
      document.querySelector(`[data-edit-row="${button.dataset.cancelEdit}"]`).hidden = true;
    });
    document.querySelectorAll('[data-save-edit]').forEach((button) => button.onclick = async () => {
      const id = button.dataset.saveEdit;
      const appPassword = document.querySelector(`[data-edit-password="${id}"]`)?.value || '';
      const loginPassword = document.querySelector(`[data-edit-login-password="${id}"]`)?.value || '';
      const patch = {
        email: document.querySelector(`[data-edit-email="${id}"]`).value.trim(),
        note: document.querySelector(`[data-edit-note="${id}"]`).value.trim(),
        ...(appPassword ? { appPassword } : {}),
        ...(loginPassword ? { loginPassword } : {})
      };
      await updateAccount(id, patch, '账号信息已修改');
    });
    document.querySelectorAll('[data-delete-account]').forEach((button) => button.onclick = async () => {
      if (!window.confirm(`确定删除账号 ${button.dataset.email} 吗？删除后无法恢复。`)) return;
      button.disabled = true;
      try {
        await api(`/api/admin/mail-accounts/${encodeURIComponent(button.dataset.deleteAccount)}`, { method: 'DELETE' });
        showResult('账号已从账号池删除');
        await loadAccounts();
      } catch (error) {
        showResult(error.message, false);
        button.disabled = false;
      }
    });
  } catch (error) { showResult(error.message, false); }
}

async function updateAccount(id, patch, successMessage = '账号配置已更新') {
  try { await api(`/api/admin/mail-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); showResult(successMessage); await loadAccounts(); }
  catch (error) { showResult(error.message, false); }
}

$('addManagedBtn').onclick = async () => {
  const button = $('addManagedBtn');
  button.disabled = true;
  try {
    if (!testedAccountToken) throw new Error('请先测试邮箱连接');
    const data = await api('/api/admin/mail-accounts', { method: 'POST', body: JSON.stringify({ email: $('managedEmail').value.trim(), appPassword: $('managedPassword').value, loginPassword: $('managedLoginPassword').value, maxUsers: Number($('managedMaxUsers').value), note: $('managedNote').value.trim(), testToken: testedAccountToken }) });
    showResult(`账号已加入资源池：${data.email}`);
    $('managedEmail').value = '';
    $('managedPassword').value = '';
    $('managedLoginPassword').value = '';
    $('managedNote').value = '';
    resetAccountTest('账号已添加。如需继续添加，请填写新账号并测试连接。');
    await loadAccounts();
  } catch (error) { showResult(error.message, false); }
  finally { button.disabled = !testedAccountToken; }
};

$('testManagedBtn').onclick = async () => {
  const button = $('testManagedBtn');
  button.disabled = true;
  $('addManagedBtn').disabled = true;
  $('accountTestState').textContent = '正在连接邮箱并验证 IMAP 服务…';
  $('accountTestState').className = 'account-test-state testing';
  try {
    const data = await api('/api/admin/mail-accounts/test', { method: 'POST', body: JSON.stringify({ email: $('managedEmail').value.trim(), appPassword: $('managedPassword').value }) });
    testedAccountToken = data.testToken;
    $('addManagedBtn').disabled = false;
    $('accountTestState').textContent = '连接成功，可以添加到账号池（测试结果 10 分钟内有效）。';
    $('accountTestState').className = 'account-test-state success';
    showResult('邮箱连接测试成功');
  } catch (error) {
    resetAccountTest('连接测试失败，请检查账号、授权码和 IMAP 服务。');
    showResult(error.message, false);
  } finally {
    button.disabled = false;
  }
};

$('batchUpdateBtn').onclick = async () => {
  const accountIds = [...document.querySelectorAll('[data-select-account]:checked')].map((checkbox) => checkbox.dataset.selectAccount);
  if (!accountIds.length) return;
  const maxUsersValue = $('batchMaxUsers').value.trim();
  const expiresValue = $('batchExpiresAt').value;
  const activeValue = $('batchActive').value;
  const noteValue = $('batchNote').value.trim();
  const patch = {
    accountIds,
    ...(maxUsersValue ? { maxUsers: Number(maxUsersValue) } : {}),
    ...(expiresValue ? { expiresAt: new Date(expiresValue).getTime() } : {}),
    ...(activeValue ? { active: activeValue === 'true' } : {}),
    ...(noteValue ? { note: noteValue } : {})
  };
  if (Object.keys(patch).length === 1) {
    showResult('请至少填写一项批量修改内容', false);
    return;
  }
  const button = $('batchUpdateBtn');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    await api('/api/admin/mail-accounts/batch-update', { method: 'POST', body: JSON.stringify(patch) });
    showResult(`已批量修改 ${accountIds.length} 个账号`);
    $('batchMaxUsers').value = '';
    $('batchExpiresAt').value = '';
    $('batchActive').value = '';
    $('batchNote').value = '';
    await loadAccounts();
  } catch (error) {
    showResult(error.message, false);
  } finally {
    button.textContent = '批量保存';
    updateSelectionUi();
  }
};

['managedEmail', 'managedPassword'].forEach((id) => $(id).addEventListener('input', () => resetAccountTest()));

$('refreshAccountsBtn').onclick = loadAccounts;
$('closeCredentialModal').onclick = closeCredentialModal;
$('credentialModal').onclick = (event) => { if (event.target === $('credentialModal')) closeCredentialModal(); };
document.querySelectorAll('[data-toggle-credential]').forEach((button) => button.onclick = () => {
  const input = $(button.dataset.toggleCredential);
  input.type = input.type === 'password' ? 'text' : 'password';
  button.textContent = input.type === 'password' ? '显示' : '隐藏';
});
document.querySelectorAll('[data-copy-credential]').forEach((button) => button.onclick = async () => {
  const input = $(button.dataset.copyCredential);
  if (!input.value) { showResult('该密码尚未配置', false); return; }
  try { await navigator.clipboard.writeText(input.value); showResult('密码已复制到剪贴板'); }
  catch { input.select(); document.execCommand('copy'); showResult('密码已复制到剪贴板'); }
});
window.adminAuthReady?.then(loadAccounts);
