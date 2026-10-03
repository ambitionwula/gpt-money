const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'gpt-money-auth-token';

function show(message, ok = false) {
  $('authResult').textContent = message;
  $('authResult').className = `result ${ok ? 'success' : 'error'}`;
}

function setTab(register) {
  $('loginTab').classList.toggle('active', !register);
  $('registerTab').classList.toggle('active', register);
  $('loginForm').hidden = register;
  $('registerForm').hidden = !register;
  $('authResult').textContent = '';
}

async function submit(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  window.authStorage.setToken(data.token, body.rememberMe === true);
  window.authStorage.setAccount(body.account);
  window.authStorage.setRememberPreference(body.rememberMe === true);
  window.location.assign(data.user?.role === 'admin' ? '/admin-users.html' : '/');
}

$('loginTab').onclick = () => setTab(false);
$('registerTab').onclick = () => setTab(true);
$('loginForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('loginForm').querySelector('button');
  button.disabled = true;
  try { await submit('/api/auth/login', { account: $('loginAccount').value.trim(), password: $('loginPassword').value, rememberMe: $('loginRememberMe').checked }); }
  catch (error) { show(error.message); }
  finally { button.disabled = false; }
};
$('registerForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('registerForm').querySelector('button');
  button.disabled = true;
  try {
    await submit('/api/auth/register', {
      account: $('registerAccount').value.trim(),
      password: $('registerPassword').value,
      confirmPassword: $('registerConfirmPassword').value,
      rememberMe: $('registerRememberMe').checked
    });
  } catch (error) { show(error.message); }
  finally { button.disabled = false; }
};

const params = new URLSearchParams(location.search);
if (params.get('mode') === 'register') setTab(true);

const savedAccount = window.authStorage.getAccount();
if (savedAccount) $('loginAccount').value = savedAccount;
$('loginRememberMe').checked = window.authStorage.getRememberPreference();
$('registerRememberMe').checked = window.authStorage.getRememberPreference();
const existingToken = window.authStorage.getToken();
if (existingToken) {
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${existingToken}` } })
    .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(); window.location.replace(data.user?.role === 'admin' ? '/admin-users.html' : '/'); })
    .catch(() => window.authStorage.clearToken());
}
