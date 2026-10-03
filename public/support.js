const support$ = (id) => document.getElementById(id);
let supportSelectedImage = null;
let supportPendingRefreshTimer = null;
let supportTickets = [];

function supportHeaders(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function supportApi(url, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, { ...options, headers: { ...supportHeaders(Boolean(options.body) && !isFormData), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function supportEscape(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function supportFormatTime(value) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

async function hydrateSupportImages(container) {
  if (!container) return;
  for (const image of container.querySelectorAll('img[data-attachment-url]')) {
    try {
      const response = await fetch(image.dataset.attachmentUrl, { headers: supportHeaders() });
      if (!response.ok) throw new Error('图片加载失败');
      image.src = URL.createObjectURL(await response.blob());
      image.removeAttribute('data-attachment-url');
      image.closest('.support-attachment')?.addEventListener('click', (event) => { event.preventDefault(); window.open(image.src, '_blank', 'noopener'); });
    } catch {
      image.replaceWith(Object.assign(document.createElement('span'), { className: 'support-image-failed', textContent: '图片暂时无法查看' }));
    }
  }
}

function renderSupportMessage(message, label) {
  const attachment = message.attachment ? `<a class="support-attachment" href="#" data-attachment-url="${supportEscape(message.attachment.url)}" data-attachment-name="${supportEscape(message.attachment.originalName)}"><img data-attachment-url="${supportEscape(message.attachment.url)}" alt="${supportEscape(message.attachment.originalName)}" loading="lazy"></a>` : '';
  const content = message.content ? `<p>${supportEscape(message.content)}</p>` : '';
  const pendingClass = message.senderId === 'ai-pending' ? ' pending' : '';
  return `<div class="support-message ${message.senderType}${pendingClass}"><small>${label} · ${supportFormatTime(message.createdAt)}</small>${content}${attachment}</div>`;
}

function hasPendingSupportAiReply() {
  return supportTickets.some((ticket) => ticket.messages.some((message) => message.senderId === 'ai-pending'));
}

function scrollSupportChatToBottom() {
  const body = support$('supportTicketList');
  if (!body) return;
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

function startSupportPendingRefresh() {
  if (supportPendingRefreshTimer) clearInterval(supportPendingRefreshTimer);
  let attempts = 0;
  supportPendingRefreshTimer = setInterval(async () => {
    attempts += 1;
    await loadSupportTickets();
    if (!hasPendingSupportAiReply() || attempts >= 30) {
      clearInterval(supportPendingRefreshTimer);
      supportPendingRefreshTimer = null;
    }
  }, 1500);
}

function renderSupportTickets(tickets) {
  supportTickets = tickets;
  const list = support$('supportTicketList');
  const activeTicket = tickets.find((ticket) => ticket.status !== 'closed');
  window.supportActiveTicketId = activeTicket?.id || null;
  support$('supportNewTicketFields').hidden = Boolean(activeTicket);
  if (!tickets.length) { list.innerHTML = '<div class="support-chat-empty">还没有客服会话，填写下方内容后发送即可开始。</div>'; scrollSupportChatToBottom(); return; }
  list.innerHTML = tickets.map((ticket) => `<div class="support-chat-ticket ${ticket.id === activeTicket?.id ? 'active' : ''}"><div class="support-ticket-head"><div><strong>${supportEscape(ticket.subject)}</strong><small>${supportFormatTime(ticket.updatedAt)}</small></div><span class="support-status ${ticket.status}">${ticket.status === 'closed' ? '已关闭' : (ticket.status === 'pending' ? '等待用户' : '处理中')}</span></div><div class="support-messages">${ticket.messages.map((message) => renderSupportMessage(message, message.senderType === 'admin' ? '人工客服' : (message.senderType === 'ai' ? '客服' : '我'))).join('')}</div></div>`).join('');
  void hydrateSupportImages(list).finally(scrollSupportChatToBottom);
  scrollSupportChatToBottom();
}

async function loadSupportTickets() {
  if (!support$('supportTicketList')) return;
  try { const data = await supportApi('/api/support/tickets'); renderSupportTickets(data.tickets || []); }
  catch (error) { support$('supportResult').textContent = error.message; support$('supportResult').className = 'result error'; }
}

function clearSupportImage() {
  const input = support$('supportImageInput');
  const preview = support$('supportImagePreview');
  supportSelectedImage = null;
  if (input) input.value = '';
  if (preview) { preview.hidden = true; preview.textContent = ''; }
}

function setSupportImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  supportSelectedImage = file;
  const preview = support$('supportImagePreview');
  preview.hidden = false;
  preview.innerHTML = `<span>已选择：${supportEscape(file.name || '截图.png')}（${Math.ceil(file.size / 1024)}KB）</span><button type="button" id="clearSupportImageBtn" aria-label="移除图片">×</button>`;
  support$('clearSupportImageBtn').onclick = clearSupportImage;
}

function installSupportDropTarget(element, onFile) {
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

support$('supportImageInput')?.addEventListener('change', () => {
  const file = support$('supportImageInput').files?.[0];
  if (!file) { clearSupportImage(); return; }
  setSupportImage(file);
});

function handleSupportPaste(event) {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (file) { event.preventDefault(); setSupportImage(new File([file], `screenshot-${Date.now()}.png`, { type: file.type || 'image/png' })); }
}
support$('supportReplyContent')?.addEventListener('paste', handleSupportPaste);
support$('supportContent')?.addEventListener('paste', handleSupportPaste);
installSupportDropTarget(support$('supportReplyContent'), setSupportImage);
installSupportDropTarget(support$('supportContent'), setSupportImage);
installSupportDropTarget(support$('supportChatPanel'), setSupportImage);

support$('supportFloatBtn')?.addEventListener('click', () => {
  const panel = support$('supportChatPanel');
  panel.hidden = !panel.hidden;
  support$('supportFloatBtn').classList.toggle('is-open', !panel.hidden);
  if (!panel.hidden) loadSupportTickets();
});
support$('closeSupportChatBtn')?.addEventListener('click', () => { support$('supportChatPanel').hidden = true; support$('supportFloatBtn').classList.remove('is-open'); });
support$('sendSupportMessageBtn')?.addEventListener('click', async () => {
  const button = support$('sendSupportMessageBtn');
  const reply = support$('supportReplyContent').value.trim();
  const subject = support$('supportSubject').value.trim();
  const content = support$('supportContent').value.trim();
  const file = supportSelectedImage || support$('supportImageInput').files?.[0];
  if (file && file.size > 5 * 1024 * 1024) { support$('supportResult').textContent = '图片不能超过 5MB'; support$('supportResult').className = 'result error'; return; }
  button.disabled = true;
  try {
    const form = new FormData();
    if (file) form.append('image', file);
    if (!window.supportActiveTicketId) {
      if (!subject || (!content && !file)) throw new Error('首次联系客服请填写问题标题，并填写问题描述或选择图片');
      form.append('subject', subject); form.append('content', content);
      await supportApi('/api/support/tickets', { method: 'POST', body: form });
      support$('supportSubject').value = ''; support$('supportContent').value = '';
    } else {
      if (!reply && !file) throw new Error('请输入客服消息或选择一张图片');
      form.append('content', reply);
      await supportApi(`/api/support/tickets/${encodeURIComponent(window.supportActiveTicketId)}/messages`, { method: 'POST', body: form });
      support$('supportReplyContent').value = '';
    }
    clearSupportImage();
    support$('supportResult').textContent = '消息已发送，正在处理中，请稍等…'; support$('supportResult').className = 'result success'; await loadSupportTickets(); scrollSupportChatToBottom(); startSupportPendingRefresh();
  } catch (error) { support$('supportResult').textContent = error.message; support$('supportResult').className = 'result error'; }
  finally { button.disabled = false; }
});

support$('userId')?.addEventListener('change', loadSupportTickets);
window.supportActiveTicketId = null;
