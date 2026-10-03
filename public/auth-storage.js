(function () {
  const key = 'gpt-money-auth-token';
  const accountKey = 'gpt-money-last-account';
  const rememberKey = 'gpt-money-remember-login';
  window.authStorage = {
    getToken() { return sessionStorage.getItem(key) || localStorage.getItem(key) || ''; },
    setToken(token, remember) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
      (remember ? localStorage : sessionStorage).setItem(key, token);
    },
    clearToken() { sessionStorage.removeItem(key); localStorage.removeItem(key); },
    getAccount() { return localStorage.getItem(accountKey) || ''; },
    setAccount(account) { if (account) localStorage.setItem(accountKey, account); },
    getRememberPreference() {
      const saved = localStorage.getItem(rememberKey);
      return saved === null ? true : saved === '1';
    },
    setRememberPreference(remember) {
      localStorage.setItem(rememberKey, remember ? '1' : '0');
    }
  };
})();
