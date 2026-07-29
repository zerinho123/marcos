// ============================================================================
// cadastro-boot.js — wiring do formulário de auto-cadastro (aprovação de admin)
// ----------------------------------------------------------------------------
// JS externo (CSP sem 'unsafe-inline'). POST público em /auth/register: sem
// sessão, sem CSRF (rota é pública e rate-limited no backend). A conta nasce
// 'pendente' — o painel admin aprova/rejeita.
// ============================================================================

const API_ORIGIN = window.__CF_API_ORIGIN__ || 'https://apifinanceiro.cfsistema.site';

const panel   = document.getElementById('register-panel');
const done    = document.getElementById('register-done');
const form    = document.getElementById('register-form');
const errSlot = document.getElementById('register-error-slot');
const submit  = document.getElementById('register-submit');
const pwInput = form.querySelector('input[name=password]');
const pwTog   = document.getElementById('pw-toggle');

document.getElementById('yr').textContent = new Date().getFullYear();

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
  if (message) errSlot.scrollIntoView({ block: 'nearest' });
}

function setLoading(on) {
  submit.disabled = on;
  submit.innerHTML = on ? '<span class="loading"></span>' : 'Enviar cadastro &rarr;';
}

form.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const data = new FormData(form);
  const nome      = String(data.get('nome') || '').trim();
  const email     = String(data.get('email') || '').trim();
  const telefone  = String(data.get('telefone') || '').trim();
  const documento = String(data.get('documento') || '').trim();
  const empresa   = String(data.get('empresa') || '').trim();
  const plano     = String(data.get('plano') || '').trim();
  const username  = String(data.get('username') || '').trim().toLowerCase();
  const password  = String(data.get('password') || '');
  const password2 = String(data.get('password2') || '');

  if (!nome || !email || !telefone || !documento || !empresa || !username || !password) {
    showError('Preencha todos os campos obrigatórios.');
    return;
  }
  if (documento.replace(/\D/g, '').length < 11) {
    showError('CPF/CNPJ inválido.');
    return;
  }
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    showError('Usuário: 3 a 64 caracteres, só letras minúsculas, números, ponto, hífen e underline.');
    return;
  }
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    showError('Senha: mínimo 8 caracteres, com ao menos uma letra e um número.');
    return;
  }
  if (password !== password2) {
    showError('As senhas não conferem.');
    return;
  }

  setLoading(true);
  showError('');
  try {
    const res = await fetch(`${API_ORIGIN}/api/finance/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, email, telefone, documento, empresa, plano: plano || undefined, username, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) throw new Error('Muitas tentativas. Aguarde um pouco e tente de novo.');
      throw new Error(body?.message || 'Não foi possível enviar o cadastro.');
    }
    panel.hidden = true;
    done.hidden = false;
  } catch (err) {
    setLoading(false);
    showError(err?.message || 'Não foi possível enviar o cadastro. Tente novamente.');
  }
});
