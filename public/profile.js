const profile$ = (id) => document.getElementById(id);

function profileHeaders(json = false) {
  const result = {};
  if (json) result['Content-Type'] = 'application/json';
  const token = window.authStorage.getToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function profileResult(message, ok = true) {
  const element = profile$('profileResult');
  element.textContent = message;
  element.className = `result ${ok ? 'success' : 'error'}`;
}

async function profileApi(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...profileHeaders(Boolean(options.body)), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function loadProfile() {
  const token = window.authStorage.getToken();
  if (!token) { window.location.replace('/auth.html'); return; }
  try {
    const data = await profileApi('/api/auth/me');
    profile$('authUserLabel').textContent = data.user.id;
    profile$('profileAccount').value = data.user.id;
    profile$('authLogoutBtn').onclick = async () => {
      await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      window.authStorage.clearToken();
      window.location.replace('/auth.html');
    };
  } catch {
    window.authStorage.clearToken();
    window.location.replace('/auth.html');
  }
}

profile$('profileForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = profile$('savePasswordBtn');
  button.disabled = true;
  button.classList.add('loading-button');
  button.textContent = '保存中…';
  try {
    await profileApi('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({
        currentPassword: profile$('currentPassword').value,
        password: profile$('newPassword').value,
        confirmPassword: profile$('confirmNewPassword').value
      })
    });
    profile$('currentPassword').value = '';
    profile$('newPassword').value = '';
    profile$('confirmNewPassword').value = '';
    profileResult('密码修改成功，当前登录仍然有效。');
  } catch (error) {
    profileResult(error.message, false);
  } finally {
    button.disabled = false;
    button.classList.remove('loading-button');
    button.textContent = '保存新密码';
  }
};

loadProfile();
