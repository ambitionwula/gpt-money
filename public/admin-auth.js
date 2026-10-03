window.adminAuthReady = (async () => {
  const token = window.authStorage.getToken();
  if (!token) { location.replace('/auth.html'); return null; }
  try {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok || data.user?.role !== 'admin') throw new Error('需要管理员权限');
    const user = data.user;
    window.currentAdmin = user;
    const primary = user.adminLevel === 'primary';
    const restrictedPages = new Set(['/admin-plans.html', '/admin-payment.html', '/admin-orders.html', '/admin-administrators.html']);
    if (!primary && restrictedPages.has(location.pathname)) {
      location.replace('/admin-users.html');
      return user;
    }

    document.querySelectorAll('.admin-subnav').forEach((nav) => {
      nav.querySelectorAll('a').forEach((link) => {
        if (!primary && ['/admin-plans.html', '/admin-payment.html', '/admin-orders.html'].includes(link.getAttribute('href'))) link.remove();
      });
      if (primary && !nav.querySelector('a[href="/admin-administrators.html"]')) {
        const link = document.createElement('a');
        link.className = `admin-subtab${location.pathname === '/admin-administrators.html' ? ' active' : ''}`;
        link.href = '/admin-administrators.html';
        link.textContent = '管理员管理';
        nav.appendChild(link);
      }
    });

    const header = document.querySelector('header');
    if (header) {
      const bar = document.createElement('div');
      bar.className = 'admin-auth-bar';
      bar.innerHTML = `<span>${user.id} · ${primary ? '主管理员' : '次级管理员'}</span><button type="button">退出登录</button>`;
      bar.querySelector('button').onclick = async () => {
        await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        window.authStorage.clearToken();
        location.replace('/auth.html');
      };
      header.appendChild(bar);
    }
    return user;
  } catch {
    window.authStorage.clearToken();
    location.replace('/auth.html');
    return null;
  }
})();
