const $ = (id) => document.getElementById(id);

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
  $('planResult').textContent = message;
  $('planResult').className = `result ${ok ? 'success' : 'error'}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatPrice(amountFen) {
  return `¥${(amountFen / 100).toFixed(2)}`;
}

function renderPlans(plans) {
  $('planRows').innerHTML = plans.length ? plans.map((plan) => `
    <article class="plan-admin-card ${plan.active ? '' : 'inactive'}" data-plan-card="${escapeHtml(plan.id)}">
      <div class="plan-admin-card-head"><div><h3>${escapeHtml(plan.name)}</h3><span>实际 ${plan.seatCount}人 · 用户显示 ${plan.displaySeatCount}人 · ${plan.durationDays}天</span></div><strong>${formatPrice(plan.amountFen)}</strong></div>
      <div class="grid three plan-edit-grid">
        <label>套餐名称<input type="text" value="${escapeHtml(plan.name)}" data-plan-name="${escapeHtml(plan.id)}"></label>
        <label>实际共享人数<input type="number" min="1" max="1000" value="${plan.seatCount}" data-plan-seats="${escapeHtml(plan.id)}"></label>
        <label>价格（元）<input type="number" min="0.01" step="0.01" value="${(plan.amountFen / 100).toFixed(2)}" data-plan-price="${escapeHtml(plan.id)}"></label>
      </div>
      <div class="plan-admin-actions"><label>用户端显示人数<input type="number" min="1" max="1000" value="${plan.displaySeatCount}" data-plan-display-seats="${escapeHtml(plan.id)}"></label><label>周期（天）<input type="number" min="1" max="3650" value="${plan.durationDays}" data-plan-duration="${escapeHtml(plan.id)}"></label><button class="table-action" data-save-plan="${escapeHtml(plan.id)}">保存配置</button><button class="table-action" data-toggle-plan="${escapeHtml(plan.id)}" data-active="${!plan.active}">${plan.active ? '停用套餐' : '启用套餐'}</button><button class="table-action danger" data-delete-plan="${escapeHtml(plan.id)}" data-plan-name-value="${escapeHtml(plan.name)}">删除套餐</button><span class="status-pill ${plan.active ? 'yes' : 'no'}">${plan.active ? '销售中' : '已停用'}</span></div>
    </article>`).join('') : '<div class="empty-state">还没有配置套餐</div>';

  document.querySelectorAll('[data-save-plan]').forEach((button) => button.onclick = () => savePlan(button.dataset.savePlan));
  document.querySelectorAll('[data-toggle-plan]').forEach((button) => button.onclick = () => updatePlan(button.dataset.togglePlan, { active: button.dataset.active === 'true' }, '套餐状态已更新'));
  document.querySelectorAll('[data-delete-plan]').forEach((button) => button.onclick = () => deletePlan(button.dataset.deletePlan, button.dataset.planNameValue));
}

async function loadPlans() {
  try {
    const data = await api('/api/admin/payment-plans');
    renderPlans(data.plans);
  } catch (error) { showResult(error.message, false); }
}

async function updatePlan(id, patch, message = '套餐配置已更新') {
  try { await api(`/api/admin/payment-plans/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); showResult(message); await loadPlans(); }
  catch (error) { showResult(error.message, false); }
}

async function savePlan(id) {
  const name = document.querySelector(`[data-plan-name="${id}"]`)?.value.trim();
  const seatCount = Number(document.querySelector(`[data-plan-seats="${id}"]`)?.value);
  const displaySeatCount = Number(document.querySelector(`[data-plan-display-seats="${id}"]`)?.value);
  const price = Number(document.querySelector(`[data-plan-price="${id}"]`)?.value);
  const durationDays = Number(document.querySelector(`[data-plan-duration="${id}"]`)?.value);
  await updatePlan(id, { name, seatCount, displaySeatCount, amountFen: Math.round(price * 100), durationDays });
}

async function deletePlan(id, name) {
  if (!window.confirm(`确认删除套餐「${name}」吗？\n删除后将不再出现在管理员套餐列表和用户购买页面；历史订单及已有订阅信息会继续保留。`)) return;
  try {
    await api(`/api/admin/payment-plans/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showResult(`套餐「${name}」已删除`);
    await loadPlans();
  } catch (error) { showResult(error.message, false); }
}

$('createPlanBtn').onclick = async () => {
  const button = $('createPlanBtn');
  button.disabled = true;
  try {
    const name = $('planName').value.trim();
    const seatCount = Number($('planSeatCount').value);
    const displaySeatCount = Number($('planDisplaySeatCount').value);
    const amountFen = Math.round(Number($('planPrice').value) * 100);
    const durationDays = Number($('planDurationDays').value);
    await api('/api/admin/payment-plans', { method: 'POST', body: JSON.stringify({ name, seatCount, displaySeatCount, amountFen, durationDays, active: true }) });
    $('planName').value = '';
    showResult('套餐创建成功');
    await loadPlans();
  } catch (error) { showResult(error.message, false); }
  finally { button.disabled = false; }
};

$('refreshPlansBtn').onclick = loadPlans;
loadPlans();
