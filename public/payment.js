const payment$ = (id) => document.getElementById(id);
const PAYMENT_AUTH_TOKEN_KEY = 'gpt-money-auth-token';
let paymentPlans = [];
let selectedPlanId = null;

function paymentHeaders(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function paymentApi(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...paymentHeaders(Boolean(options.body)), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function paymentEscape(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function paymentPrice(amountFen) { return `¥${(amountFen / 100).toFixed(2)}`; }
function paymentFormatExpiry(value) { return value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : ''; }
function paymentResult(message, ok = true) { payment$('paymentResult').textContent = message; payment$('paymentResult').className = `result ${ok ? 'success' : 'error'}`; }

function renderPaymentPlans(plans, currentPlanId = null, locked = false) {
  paymentPlans = plans;
  if (!plans.length) { selectedPlanId = null; payment$('paymentPlans').innerHTML = '<div class="empty-inline">暂无可购买套餐，请联系管理员配置</div>'; return; }
  selectedPlanId = plans.some((plan) => plan.id === selectedPlanId) ? selectedPlanId : (plans.some((plan) => plan.id === currentPlanId) ? currentPlanId : plans[0].id);
  payment$('paymentPlans').innerHTML = plans.map((plan) => `<button type="button" class="payment-plan ${plan.id === selectedPlanId ? 'active' : ''}" data-plan-choice="${paymentEscape(plan.id)}" ${locked ? 'disabled' : ''}><span class="payment-plan-name">${paymentEscape(plan.name)}</span><strong>${paymentPrice(plan.amountFen)}</strong><small>${plan.displaySeatCount ?? plan.seatCount}人共享 · ${plan.durationDays}天${locked ? ' · 当前套餐' : ''}</small></button>`).join('');
  document.querySelectorAll('[data-plan-choice]').forEach((button) => { button.onclick = () => { selectedPlanId = button.dataset.planChoice; renderPaymentPlans(paymentPlans, currentPlanId, locked); }; });
}

function openPaymentConfirmModal(plan) {
  return new Promise((resolve) => {
    const modal = payment$('paymentConfirmModal');
    const confirmButton = payment$('confirmPaymentBtn');
    const cancelButton = payment$('cancelPaymentConfirmBtn');
    payment$('paymentConfirmText').innerHTML = `你选择了「${paymentEscape(plan.name)}」<br><strong>${paymentPrice(plan.amountFen)}</strong> · ${plan.durationDays}天 · ${plan.displaySeatCount ?? plan.seatCount}人共享<br><span>确认后将创建一笔待支付订单。</span>`;
    modal.hidden = false;
    const finish = (confirmed) => { modal.hidden = true; confirmButton.disabled = false; confirmButton.textContent = '确认创建订单'; cancelButton.onclick = null; modal.onclick = null; document.removeEventListener('keydown', onKeyDown); resolve(confirmed); };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKeyDown);
    confirmButton.focus();
  });
}

async function loadPaymentStatus() {
  try {
    const [data, planData] = await Promise.all([paymentApi('/api/payment/me'), paymentApi('/api/payment/plans')]);
    const locked = data.subscriptionLocked === true || planData.subscriptionLocked === true;
    renderPaymentPlans(planData.plans || [], data.currentPlan?.id || null, locked);
    payment$('paymentPlanHint').textContent = locked ? '当前套餐有效期内只能使用这一套餐，到期后将重新显示全部套餐。' : '套餐人数代表同一个邮箱账号允许共享的用户数量。';
    payment$('createPaymentBtn').disabled = locked;
    payment$('createPaymentBtn').textContent = locked ? '套餐有效期内不可重复订购' : '立即支付';
    payment$('paymentStatus').textContent = data.paid ? `已付费 · ${data.currentPlan ? `${data.currentPlan.name} · ` : ''}${paymentFormatExpiry(data.paidUntil)} 到期` : (data.paused ? `已暂停 · ${paymentFormatExpiry(data.paidUntil)} 到期` : '未付费');
    payment$('paymentStatus').style.color = data.paid ? '#16734a' : (data.paused ? '#946a00' : '#a34a55');
  } catch (error) { payment$('paymentStatus').textContent = error.message || '无法获取'; }
}

async function loadPaymentAuth() {
  const token = window.authStorage.getToken();
  if (!token) { window.location.replace('/auth.html'); return; }
  try {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录已失效');
    if (data.user.role === 'admin') { window.location.replace('/admin-users.html'); return; }
    payment$('authUserLabel').textContent = `${data.user.id}${data.user.role === 'admin' ? ' · 管理员' : ''}`;
    payment$('authLoginLink').hidden = true;
    payment$('profileLink').hidden = false;
    payment$('authLogoutBtn').hidden = false;
    payment$('authLogoutBtn').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); window.authStorage.clearToken(); window.location.replace('/auth.html'); };
  } catch { window.authStorage.clearToken(); window.location.replace('/auth.html'); }
}

payment$('createPaymentBtn').onclick = async () => {
  if (!selectedPlanId) { paymentResult('暂无可购买套餐，请联系管理员配置', false); return; }
  const plan = paymentPlans.find((item) => item.id === selectedPlanId);
  if (!plan) { paymentResult('套餐不存在，请刷新后重试', false); return; }
  if (!await openPaymentConfirmModal(plan)) { paymentResult('已取消创建订单'); return; }
  const button = payment$('createPaymentBtn'); button.disabled = true; button.classList.add('loading-button'); button.textContent = '创建中…';
  try {
    const data = await paymentApi('/api/payment/orders', { method: 'POST', body: JSON.stringify({ planId: selectedPlanId }) });
    paymentResult(`已创建「${plan.name}」订单，正在跳转支付…`);
    if (data.paymentUrl) window.location.assign(data.paymentUrl);
  } catch (error) { paymentResult(error.message, false); }
  finally { button.disabled = false; button.classList.remove('loading-button'); button.textContent = '立即支付'; }
};

payment$('healthBadge').textContent = '服务在线';
payment$('healthBadge').className = 'badge ok';
loadPaymentAuth().then(loadPaymentStatus);
