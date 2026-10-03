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
  $('paymentSettingsResult').textContent = message;
  $('paymentSettingsResult').className = `result ${ok ? 'success' : 'error'}`;
}

function fillSettings(settings) {
  $('paymentEnabled').checked = Boolean(settings.enabled);
  $('paymentGatewayType').value = settings.gatewayType || 'epay';
  $('paymentGatewayUrl').value = settings.gatewayUrl || '';
  $('paymentMerchantId').value = settings.merchantId || '';
  $('paymentMerchantKey').value = '';
  $('paymentMerchantKey').placeholder = settings.hasMerchantKey ? '已配置，留空表示不修改' : '首次填写必填';
  $('paymentMinAmount').value = ((settings.minAmountFen || 100) / 100).toFixed(2);
  $('paymentReturnUrl').value = settings.returnUrl || '';
  $('paymentCallbackBaseUrl').value = settings.callbackBaseUrl || '';
}

async function loadSettings() {
  try { fillSettings((await api('/api/admin/payment-settings')).settings); }
  catch (error) { showResult(error.message, false); }
}

$('savePaymentSettingsBtn').onclick = async () => {
  const button = $('savePaymentSettingsBtn');
  button.disabled = true;
  try {
    await api('/api/admin/payment-settings', { method: 'PUT', body: JSON.stringify({
      enabled: $('paymentEnabled').checked,
      gatewayType: $('paymentGatewayType').value,
      gatewayUrl: $('paymentGatewayUrl').value.trim(),
      callbackBaseUrl: $('paymentCallbackBaseUrl').value.trim(),
      returnUrl: $('paymentReturnUrl').value.trim(),
      merchantId: $('paymentMerchantId').value.trim(),
      merchantKey: $('paymentMerchantKey').value.trim() || undefined,
      minAmountFen: Math.round(Number($('paymentMinAmount').value) * 100)
    }) });
    $('paymentMerchantKey').value = '';
    showResult('支付配置已保存，商户密钥已加密存储');
    await loadSettings();
  } catch (error) { showResult(error.message, false); }
  finally { button.disabled = false; }
};

$('refreshPaymentSettingsBtn').onclick = loadSettings;
loadSettings();
