// ============================================================================
// login-boot.js — wiring do formulario de login
// ----------------------------------------------------------------------------
// Externalizado do <script type="module"> inline do login.html para permitir
// CSP sem 'unsafe-inline' em script-src. Comportamento identico ao anterior.
// ============================================================================
import { login } from './security-client.js?v=20260727-finance-v87';

const form    = document.getElementById('auth-form');
const errSlot = document.getElementById('auth-error-slot');
const submit  = document.getElementById('auth-submit');
const usernameInput = form.querySelector('input[name=username]');
const pwInput = form.querySelector('input[name=password]');
const pwTog   = document.getElementById('pw-toggle');
const rememberInput = document.getElementById('remember-login');
const REMEMBER_KEY = 'cf-finance-login-username';

document.getElementById('yr').textContent = new Date().getFullYear();

function readSavedLogin() {
  try {
    return localStorage.getItem(REMEMBER_KEY) || '';
  } catch (_) {
    return '';
  }
}

function persistSavedLogin(username, shouldSave) {
  try {
    if (shouldSave) localStorage.setItem(REMEMBER_KEY, username);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch (_) {
    // Ignora bloqueios de storage em modo privado/restrito.
  }
}

const savedUsername = readSavedLogin();
if (savedUsername && usernameInput && rememberInput) {
  usernameInput.value = savedUsername;
  rememberInput.checked = true;
  pwInput.focus();
}

pwTog.addEventListener('click', () => {
  const show = pwInput.type === 'password';
  pwInput.type = show ? 'text' : 'password';
  pwTog.textContent = show ? 'Ocultar' : 'Mostrar';
  pwInput.focus();
});

function showError(message) {
  errSlot.innerHTML = message
    ? `<div class="login-error">${String(message).replace(/</g, '&lt;')}</div>`
    : '';
}

function setLoading(on) {
  submit.disabled = on;
  submit.innerHTML = on ? '<span class="loading"></span>' : 'Entrar &rarr;';
}

form.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const data = new FormData(form);
  const username = String(data.get('username') || '').trim();
  const password = String(data.get('password') || '');
  if (!username || !password) {
    showError('Preencha usuário e senha.');
    return;
  }
  setLoading(true);
  showError('');
  try {
    await login({ username, password });
    persistSavedLogin(username, Boolean(rememberInput?.checked));
    window.location.replace('./app.html');
  } catch (err) {
    setLoading(false);
    const code = err?.status;
    if (code === 429) {
      showError('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    } else if (code === 401) {
      showError('Usuário ou senha inválidos.');
    } else if (code === 0 || code === undefined) {
      showError('Sem conexão com o servidor. Tente novamente em instantes.');
    } else {
      showError(err?.message || 'Não foi possível autenticar.');
    }
  }
});
