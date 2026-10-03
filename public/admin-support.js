const $ = (id) => document.getElementById(id);
let tickets = [];
let selectedTicketId = null;
let supportAdminSelectedImage = null;

function headers(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function api(url, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, { ...options, headers: { ...headers(Boolean(options.body) && !isFormData), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function showResult(id, message, ok = true) { $(id).textContent = message; $(id).className = `result ${ok ? 'success' : 'error'}`; }

function installAdminDropTarget(element, onFile) {
  if (!element) return;
  ['dragenter', 'dragover'].forEach((eventName) => element.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => element.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('is-dragging');
  }));
  element.addEventListener('drop', (event) => {
    const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith('image/'));
    if (file) onFile(file);
  });
}

async function hydrateAdminImages(container) {
  if (!container) return;
  for (const image of container.querySelectorAll('img[data-attachment-url]')) {
    try {
      const response = await fetch(image.dataset.attachmentUrl, { headers: headers() });
      if (!response.ok) throw new Error('图片加载失败');
      image.src = URL.createObjectURL(await response.blob());
      image.removeAttribute('data-attachment-url');
      image.closest('.support-attachment')?.addEventListener('click', (event) => { event.preventDefault(); window.open(image.src, '_blank', 'noopener'); });
    } catch {
      image.replaceWith(Object.assign(document.createElement('span'), { className: 'support-image-failed', textContent: '图片暂时无法查看' }));
    }
  }
}

function renderAdminMessage(message, ticket) {
  const label = message.senderType === 'admin' ? '人工客服' : message.senderType === 'ai' ? 'AI 客服' : `用户 ${escapeHtml(ticket.userId)}`;
  const attachment = message.attachment ? `<a class="support-attachment" href="#"><img data-attachment-url="${escapeHtml(message.attachment.url)}" alt="${escapeHtml(message.attachment.originalName)}" loading="lazy"></a>` : '';
  const content = message.content ? `<p>${escapeHtml(message.content)}</p>` : '';
  const pendingClass = message.senderId === 'ai-pending' ? ' pending' : '';
  return `<div class="support-message ${message.senderType}${pendingClass}"><small>${label} · ${formatTime(message.createdAt)}</small>${content}${attachment}</div>`;
}

function renderTicketList() {
  $('adminSupportTickets').innerHTML = tickets.length ? tickets.map((ticket) => `<button type="button" class="support-admin-ticket ${ticket.id === selectedTicketId ? 'active' : ''}" data-ticket-id="${ticket.id}"><strong>${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(ticket.userId)} · ${ticket.status === 'closed' ? '已关闭' : ticket.status === 'pending' ? '等待用户' : '处理中'}</small><time>${formatTime(ticket.updatedAt)}</time></button>`).join('') : '<div class="empty-inline">暂无客服工单</div>';
  document.querySelectorAll('[data-ticket-id]').forEach((button) => button.onclick = () => { selectedTicketId = button.dataset.ticketId; renderTicketList(); renderDetail(); });
}

function renderDetail() {
  const ticket = tickets.find((item) => item.id === selectedTicketId);
  if (!ticket) { $('adminSupportDetail').innerHTML = '<div class="empty-state">请选择左侧工单</div>'; return; }
  $('adminSupportDetail').innerHTML = `<div class="support-detail-head"><div><h3>${escapeHtml(ticket.subject)}</h3><small>用户：${escapeHtml(ticket.userId)} · 创建于 ${formatTime(ticket.createdAt)}</small></div><select id="supportTicketStatus"><option value="open" ${ticket.status === 'open' ? 'selected' : ''}>处理中</option><option value="pending" ${ticket.status === 'pending' ? 'selected' : ''}>等待用户</option><option value="closed" ${ticket.status === 'closed' ? 'selected' : ''}>已关闭</option></select></div>
    <div class="support-messages admin-messages">${ticket.messages.map((message) => renderAdminMessage(message, ticket)).join('')}</div>
    <div class="support-admin-actions"><textarea id="supportReplyContent" rows="4" maxlength="3000" placeholder="输入人工回复内容，可直接粘贴截图"></textarea><div class="support-admin-compose"><label class="support-image-btn" title="选择或粘贴图片">📷<input id="supportAdminImageInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden></label><span id="supportAdminImageName" class="muted">未选择图片</span></div><div class="actions"><button id="supportReplyBtn" class="primary">发送人工回复</button>${window.currentAdmin?.adminLevel === 'primary' ? '<button id="supportRestoreBtn">恢复订阅 30 天</button>' : ''}</div><p id="supportDetailResult" class="result"></p></div>`;
  hydrateAdminImages($('adminSupportDetail'));
  supportAdminSelectedImage = null;
  const setAdminImage = (file) => { if (!file || !file.type.startsWith('image/')) return; supportAdminSelectedImage = file; $('supportAdminImageName').textContent = `${file.name || '截图.png'}（${Math.ceil(file.size / 1024)}KB）`; };
  $('supportAdminImageInput').onchange = () => { const file = $('supportAdminImageInput').files?.[0]; if (file) setAdminImage(file); };
  $('supportReplyContent').addEventListener('paste', (event) => { const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === 'file' && entry.type.startsWith('image/')); if (!item) return; const file = item.getAsFile(); if (file) { event.preventDefault(); setAdminImage(new File([file], `screenshot-${Date.now()}.png`, { type: file.type || 'image/png' })); } });
  installAdminDropTarget($('supportReplyContent'), setAdminImage);
  installAdminDropTarget($('adminSupportDetail'), setAdminImage);
  $('supportTicketStatus').onchange = async () => { try { await api(`/api/admin/support/tickets/${encodeURIComponent(ticket.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: $('supportTicketStatus').value }) }); await loadTickets(); showResult('supportDetailResult', '工单状态已更新'); } catch (error) { showResult('supportDetailResult', error.message, false); } };
  $('supportReplyBtn').onclick = async () => { const content = $('supportReplyContent').value.trim(); const file = supportAdminSelectedImage || $('supportAdminImageInput').files?.[0]; if (!content && !file) { showResult('supportDetailResult', '请输入回复内容或选择一张图片', false); return; } if (file && file.size > 5 * 1024 * 1024) { showResult('supportDetailResult', '图片不能超过 5MB', false); return; } const button = $('supportReplyBtn'); button.disabled = true; try { const form = new FormData(); form.append('content', content); if (file) form.append('image', file); await api(`/api/admin/support/tickets/${encodeURIComponent(ticket.id)}/reply`, { method: 'POST', body: form }); showResult('supportDetailResult', '人工回复已发送'); await loadTickets(); } catch (error) { showResult('supportDetailResult', error.message, false); } finally { button.disabled = false; } };
  const restoreButton = $('supportRestoreBtn');
  if (restoreButton) restoreButton.onclick = async () => { if (!window.confirm(`确认恢复用户 ${ticket.userId} 的订阅 30 天吗？`)) return; restoreButton.disabled = true; try { await api(`/api/admin/support/tickets/${encodeURIComponent(ticket.id)}/restore-subscription`, { method: 'POST', body: JSON.stringify({ days: 30 }) }); showResult('supportDetailResult', '已人工恢复订阅 30 天'); } catch (error) { showResult('supportDetailResult', error.message, false); } finally { restoreButton.disabled = false; } };
}

async function loadTickets() { try { const data = await api('/api/admin/support/tickets'); tickets = data.tickets || []; if (!selectedTicketId || !tickets.some((ticket) => ticket.id === selectedTicketId)) selectedTicketId = tickets[0]?.id || null; renderTicketList(); renderDetail(); } catch (error) { showResult('supportAiResult', error.message, false); } }

async function loadAiConfig() { try { const data = await api('/api/admin/support/ai-config'); const config = data.config; $('supportAiBaseUrl').value = config.baseUrl || ''; $('supportAiModel').value = config.model || ''; $('supportAiActive').checked = Boolean(config.active); $('supportAiKey').placeholder = config.hasApiKey ? '已配置，留空表示不修改' : '首次配置必填'; } catch (error) { showResult('supportAiResult', error.message, false); } }

async function detectSupportModels() {
  const button = $('detectSupportModelsBtn');
  button.disabled = true; button.textContent = '检测中…';
  try {
    const data = await api('/api/admin/support/ai-config/models', { method: 'POST', body: JSON.stringify({ baseUrl: $('supportAiBaseUrl').value.trim(), apiKey: $('supportAiKey').value.trim() || undefined }) });
    const select = $('supportAiModelSelect');
    select.innerHTML = data.models.length ? `<option value="">选择已检测模型…</option>${data.models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')}` : '<option value="">未返回模型列表，请手动填写</option>';
    select.hidden = !data.models.length;
    select.onchange = () => { if (select.value) $('supportAiModel').value = select.value; };
    showResult('supportAiResult', data.models.length ? `检测到 ${data.models.length} 个可用模型，请选择后保存` : '接口可访问，但没有返回模型列表，请手动填写模型名称');
  } catch (error) { showResult('supportAiResult', error.message, false); } finally { button.disabled = false; button.textContent = '检测可用模型'; }
}

$('saveSupportAiBtn').onclick = async () => { const button = $('saveSupportAiBtn'); button.disabled = true; try { await api('/api/admin/support/ai-config', { method: 'PUT', body: JSON.stringify({ baseUrl: $('supportAiBaseUrl').value.trim(), model: $('supportAiModel').value.trim(), apiKey: $('supportAiKey').value.trim() || undefined, active: $('supportAiActive').checked }) }); $('supportAiKey').value = ''; showResult('supportAiResult', 'AI 客服配置已保存，API Key 已加密存储'); await loadAiConfig(); } catch (error) { showResult('supportAiResult', error.message, false); } finally { button.disabled = false; } };
$('testSupportAiBtn').onclick = async () => { const button = $('testSupportAiBtn'); button.disabled = true; button.textContent = '测试中…'; try { const data = await api('/api/admin/support/ai-config/test', { method: 'POST' }); showResult('supportAiResult', `模型连接成功：${data.reply || '连接成功'}`); } catch (error) { showResult('supportAiResult', error.message, false); } finally { button.disabled = false; button.textContent = '测试配置'; } };
$('detectSupportModelsBtn').onclick = detectSupportModels;
window.adminAuthReady?.then(() => { loadAiConfig(); loadTickets(); });
