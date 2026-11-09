'use strict';
/* MAX demo front-end. Renders the extracted MAX markup and drives the JSON API + SSE. */

/* ---------------------------------------------------------------- utils */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function svgIcon(name, size, style) {
  return '<svg aria-hidden="true" width="' + (size || 16) + '" height="' + (size || 16) + '"'
    + (style ? ' style="' + style + '"' : '')
    + '><use href="#icon_' + name + '"></use></svg>';
}

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (S.token) init.headers['Authorization'] = 'Bearer ' + S.token;
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch (e) { /* noop */ }
  if (!res.ok) {
    const err = new Error(data.error || ('Ошибка ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function fmtDaySeparator(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now.getTime() - 86400000);
  if (dayKey(ts) === dayKey(now.getTime())) return 'Сегодня';
  if (dayKey(ts) === dayKey(yest.getTime())) return 'Вчера';
  const base = d.getDate() + ' ' + MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear() ? base : base + ' ' + d.getFullYear();
}

function fmtListTime(ts) {
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return fmtTime(ts);
  const d = new Date(ts);
  if (d.getFullYear() === now.getFullYear()) return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1);
  return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + pad2(s);
}

function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}

/* ---------------------------------------------------------------- state */

const S = {
  token: localStorage.getItem('max_token') || null,
  me: null,
  chats: [],
  messages: [],
  activeChatId: null,
  folder: 'all',
  screen: 'placeholder',
  genericKind: null,
  prevScreen: 'placeholder',
  replyTo: null,
  es: null,
  online: {},
  typing: {},        // number -> timestamp until which peer is "typing"
  typingLastSent: 0,
  unreadBelow: 0,
  playingVoice: null,
  call: null,        // { data, direction, state }
  callTimer: null,
  menuClose: null,
  searchUsers: null, // aside search results
  lastFocusedMsg: null,
};

/* -------------------------------------------------------------- avatars */

function avatarInner(u, size) {
  const st = 'width:' + size + 'px;height:' + size + 'px;';
  if (u && u.avatar) {
    return '<img class="img avatarImage svelte-1aizpza" src="' + esc(u.avatar)
      + '" alt="" draggable="false" style="' + st + 'object-fit:cover;">';
  }
  const letter = esc(((u && u.name) || '?').trim().charAt(0).toUpperCase() || '?');
  return '<span style="' + st + 'border-radius:50%;background:var(--background-tertiary);color:var(--text-tertiary);'
    + 'display:inline-flex;align-items:center;justify-content:center;'
    + 'font:600 ' + Math.max(11, Math.round(size * 0.4)) + 'px/1 var(--font);">' + letter + '</span>';
}

function avatarHtml(u, size) {
  return '<div class="image-placeholder svelte-1aizpza" style="width:' + size + 'px;height:' + size
    + 'px;display:inline-block;position:relative;">' + avatarInner(u, size) + '</div>';
}

function numberName(number) {
  if (S.me && number === S.me.number) return S.me.name || 'Я';
  const chat = S.chats.find((c) => c.peer && c.peer.number === number);
  if (chat) return chat.peer.name || number;
  if (S.searchUsers) {
    const u = S.searchUsers.find((x) => x.number === number);
    if (u) return u.name || number;
  }
  return number;
}

function peerOf(chat) { return chat && chat.peer ? chat.peer : { number: '?', name: '?' }; }

function peerOnline(chat) {
  const p = peerOf(chat);
  if (S.online[p.number] !== undefined) return S.online[p.number];
  return !!p.online;
}

/* ------------------------------------------------------------- snackbars */

function showSnack(text, ms) {
  const root = $('#snackbarRoot');
  root.style.display = 'flex';
  const item = h('<div class="item svelte-1odc7u8"><div class="snackbar svelte-1odc7u8">'
    + '<div class="content svelte-1odc7u8"><span class="description svelte-dvfghq weight-400">'
    + esc(text) + '</span></div></div></div>');
  root.appendChild(item);
  $('#liveRegion').textContent = text;
  setTimeout(() => {
    item.remove();
    if (!root.children.length) root.style.display = 'none';
  }, ms || 3000);
}

/* ---------------------------------------------------------------- dialog */

function openDialog(inner) {
  const dlg = $('#dialog');
  $('#dialogContent').innerHTML = inner;
  if (!dlg.open) dlg.showModal();
  return $('#dialogContent');
}

function closeDialog() {
  const dlg = $('#dialog');
  if (dlg.open) dlg.close();
}

function confirmDialog(title, text, actionLabel, danger, onOk) {
  const el = openDialog(
    '<div style="padding:24px 16px 16px;display:flex;flex-direction:column;gap:12px;">'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">' + esc(title) + '</div>'
    + (text ? '<div class="body svelte-dvfghq weight-400 text-secondary">' + esc(text) + '</div>' : '')
    + '</div>'
    + '<div class="buttonStack svelte-46f2bg" style="padding-bottom:16px;">'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--secondary svelte-1aw1384" data-act="cancel" type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Отмена</span></div></button></div>'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium ' + (danger ? 'button--destructive' : 'button--primary') + ' svelte-1aw1384" data-act="ok" type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">' + esc(actionLabel) + '</span></div></button></div>'
    + '</div>'
  );
  $('[data-act=cancel]', el).onclick = closeDialog;
  $('[data-act=ok]', el).onclick = () => { closeDialog(); onOk(); };
}

$('#dialog').addEventListener('click', (e) => {
  if (e.target === $('#dialog')) closeDialog();
});

/* ----------------------------------------------------------- context menu */

function showMenu(items, x, y) {
  const backdrop = $('#menuBackdrop');
  const menu = $('#actionsMenu');
  menu.innerHTML = items.map((it, i) =>
    '<button class="actionsMenuItem svelte-1vmi1g1' + (it.danger ? ' actionsMenuItem--danger' : '') + '" data-i="' + i + '" type="button"'
    + (it.disabled ? ' disabled' : '') + '>'
    + (it.icon ? '<span style="display:flex;color:inherit">' + svgIcon(it.icon, 20) + '</span>' : '')
    + '<span class="title svelte-1vmi1g1">' + esc(it.label) + '</span></button>'
  ).join('');
  backdrop.style.display = 'block';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vx = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  const vy = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
  menu.style.left = vx + 'px';
  menu.style.top = vy + 'px';
  $$('.actionsMenuItem', menu).forEach((b) => {
    b.onclick = () => {
      hideMenu();
      const it = items[+b.dataset.i];
      if (it && it.onClick) it.onClick();
    };
  });
  if (S.menuClose) document.removeEventListener('mousedown', S.menuClose);
  S.menuClose = (e) => { if (!menu.contains(e.target)) hideMenu(); };
  setTimeout(() => document.addEventListener('mousedown', S.menuClose), 0);
}

function hideMenu() {
  $('#menuBackdrop').style.display = 'none';
  if (S.menuClose) {
    document.removeEventListener('mousedown', S.menuClose);
    S.menuClose = null;
  }
}

$('#menuBackdrop').addEventListener('mousedown', (e) => {
  if (e.target === $('#menuBackdrop')) hideMenu();
});

/* ------------------------------------------------------------------ auth */

const AUTH_LOGO = $('.authLogo') ? $('.authLogo').style.getPropertyValue('--auth-logo') : '';

function authLogoHtml() {
  return '<span class="authLogo svelte-vywflk" style="--auth-logo:' + AUTH_LOGO + '"></span>';
}

function setAuthError(msg) {
  const box = $('#authError');
  if (!box) return;
  box.textContent = msg || '';
  box.style.display = msg ? '' : 'none';
}

function showAuth() {
  $('#authRoot').style.display = 'grid';
  $('#appRoot').style.display = 'none';
  $('#recoveryRoot').style.display = 'none';
  renderAuthStep('number');
}

function hideBoot() {
  const b = $('#boot-loader');
  if (b) b.remove();
}

function passwordFieldHtml(id, placeholder) {
  return '<div class="input input--secondary svelte-dp7rey">'
    + '<input class="field svelte-dp7rey svelte-vywflk" id="' + id + '" type="password" placeholder="'
    + esc(placeholder || 'Пароль') + '" autocomplete="current-password">'
    + '<span class="icon icon--right svelte-dp7rey"><button type="button" class="eyeBtn" data-eye="' + id
    + '" style="background:none;border:none;padding:0;cursor:pointer;color:inherit;display:flex">'
    + svgIcon('eye', 20) + '</button></span></div>';
}

function bindEyeButtons(root) {
  $$('[data-eye]', root).forEach((b) => {
    b.onclick = () => {
      const inp = $('#' + b.dataset.eye);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = svgIcon(show ? 'eye_crossed' : 'eye', 20);
    };
  });
}

function footerPrimary(label, id) {
  return '<div class="buttonStack buttonStack--primary buttonStack--large svelte-46f2bg">'
    + '<button class="button button--large button--accent-primary button--stretched svelte-kxwiet" id="'
    + id + '" type="button"><div class="button-inner svelte-kxwiet">' + esc(label) + '</div></button></div>';
}

function langAndLegal() {
  return '<button class="button button--link button--accent-tertiary svelte-kxwiet languageSwitch svelte-vywflk" type="button" id="langBtn">Русский</button>'
    + '<a class="legal-link svelte-vywflk description svelte-dvfghq weight-400" href="#" onclick="return false">Продолжая, вы принимаете Условия использования</a>';
}

function formatPhoneInput(inp) {
  const digits = inp.value.replace(/\D/g, '').slice(0, 10);
  let out = digits;
  if (digits.length > 1) out = '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
  if (digits.length > 6) out = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6, 8);
  if (digits.length > 8) out = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6, 8) + '-' + digits.slice(8, 10);
  inp.value = out;
  return digits;
}

let authPhone = '';

function renderAuthStep(step, info) {
  const form = $('#authForm');
  const footer = $('#authFooter');
  $('#recoveryRoot').style.display = 'none';
  $('#authRoot').style.display = 'grid';
  $('#authCard').className = 'auth auth--regular svelte-vywflk';

  if (step === 'number') {
    form.innerHTML =
      '<div class="explainer svelte-vywflk">'
      + '<div class="header svelte-dvfghq weight-600 text-primary">Введите номер</div>'
      + '<div class="smsInfo svelte-vywflk">Номер телефона — это ваш логин.<br>Подойдёт любой номер.</div>'
      + '</div>'
      + '<div class="input input--secondary svelte-dp7rey">'
      + '<span class="prefix svelte-dp7rey">+7</span>'
      + '<input class="field svelte-dp7rey svelte-vywflk" id="authInput" type="tel" inputmode="tel" placeholder="(900) 111-22-33" autocomplete="tel">'
      + '</div>'
      + '<div id="authError" class="smsInfo svelte-vywflk" style="display:none;color:var(--text-negative)"></div>';
    footer.innerHTML = footerPrimary('Далее', 'authSubmit') + langAndLegal();
    const inp = $('#authInput');
    inp.addEventListener('input', () => formatPhoneInput(inp));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#authSubmit').click(); });
    $('#authSubmit').onclick = async () => {
      const digits = inp.value.replace(/\D/g, '');
      if (digits.length < 10) return setAuthError('Введите номер из 10 цифр');
      setAuthError('');
      try {
        const r = await api('/api/auth/step1', { method: 'POST', body: { number: digits } });
        authPhone = r.number;
        renderAuthStep(r.mode, r);
      } catch (e) { setAuthError(e.message); }
    };
    setTimeout(() => inp.focus(), 0);
    return;
  }

  if (step === 'set-password') {
    form.innerHTML =
      '<div class="explainer svelte-vywflk">'
      + '<div class="explainer-icon svelte-vywflk">' + svgIcon('password', 40) + '</div>'
      + '<div class="header svelte-dvfghq weight-600 text-primary">Придумайте пароль</div>'
      + '<div class="smsInfo svelte-vywflk">Пароль понадобится, чтобы войти с этого номера.</div>'
      + '</div>'
      + '<div class="names svelte-vywflk" style="display:flex;flex-direction:column;gap:12px;">'
      + '<div class="input input--secondary svelte-dp7rey"><input class="field svelte-dp7rey svelte-vywflk" id="authName" type="text" placeholder="Имя (необязательно)" maxlength="64"></div>'
      + passwordFieldHtml('authPassword', 'Пароль')
      + '</div>'
      + '<div id="authError" class="smsInfo svelte-vywflk" style="display:none;color:var(--text-negative)"></div>';
    footer.innerHTML = footerPrimary('Создать аккаунт', 'authSubmit') + langAndLegal();
    bindEyeButtons(form);
    $('#authSubmit').onclick = async () => {
      const pass = $('#authPassword').value;
      const name = $('#authName').value.trim();
      if (pass.length < 3) return setAuthError('Пароль от 3 символов');
      setAuthError('');
      try {
        const r = await api('/api/auth/set-password', { method: 'POST', body: { number: authPhone, password: pass } });
        if (name) {
          try { await api('/api/me', { method: 'POST', body: { name } }); } catch (e) { /* noop */ }
        }
        enterApp(r.token, r.user);
      } catch (e) { setAuthError(e.message); }
    };
    setTimeout(() => $('#authPassword').focus(), 0);
    return;
  }

  if (step === 'login') {
    form.innerHTML =
      '<div class="explainer svelte-vywflk">'
      + '<div class="explainer-icon svelte-vywflk">' + svgIcon('password', 40) + '</div>'
      + '<div class="header svelte-dvfghq weight-600 text-primary">Введите пароль</div>'
      + '<div class="smsInfo svelte-vywflk">' + esc(info && info.name ? info.name : '') + ' · +' + esc(authPhone) + '</div>'
      + '</div>'
      + passwordFieldHtml('authPassword', 'Пароль')
      + '<div id="authError" class="smsInfo svelte-vywflk" style="display:none;color:var(--text-negative)"></div>';
    footer.innerHTML = footerPrimary('Войти', 'authSubmit')
      + '<button class="button button--link button--accent-tertiary svelte-kxwiet" type="button" id="forgotBtn">Забыли пароль?</button>'
      + '<button class="button button--link button--accent-tertiary svelte-kxwiet" type="button" id="changeNumber">Изменить номер</button>'
      + langAndLegal();
    bindEyeButtons(form);
    $('#authSubmit').onclick = async () => {
      const pass = $('#authPassword').value;
      if (!pass) return setAuthError('Введите пароль');
      setAuthError('');
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: { number: authPhone, password: pass } });
        enterApp(r.token, r.user);
      } catch (e) { setAuthError(e.message); }
    };
    $('#forgotBtn').onclick = () => renderRecovery();
    $('#changeNumber').onclick = () => renderAuthStep('number');
    setTimeout(() => $('#authPassword').focus(), 0);
    return;
  }
}

function renderRecovery() {
  const root = $('#recoveryRoot');
  $('#authRoot').style.display = 'none';
  root.style.display = 'grid';
  root.innerHTML =
    '<div class="auth auth--regular svelte-vywflk">'
    + '<div class="header svelte-vywflk"><div class="logoWrapper svelte-vywflk"><div class="logo svelte-vywflk">'
    + authLogoHtml() + '</div></div></div>'
    + '<div class="form svelte-vywflk" id="recForm">'
    + '<div class="explainer svelte-vywflk">'
    + '<div class="explainer-icon svelte-vywflk">' + svgIcon('password', 40) + '</div>'
    + '<div class="header svelte-dvfghq weight-600 text-primary">Восстановление пароля</div>'
    + '<div class="smsInfo svelte-vywflk">Введите номер и придумайте новый пароль.</div>'
    + '</div>'
    + '<div class="input input--secondary svelte-dp7rey"><span class="prefix svelte-dp7rey">+7</span>'
    + '<input class="field svelte-dp7rey svelte-vywflk" id="recNumber" type="tel" placeholder="(900) 111-22-33"></div>'
    + passwordFieldHtml('recPassword', 'Новый пароль')
    + '<div id="authError" class="smsInfo svelte-vywflk" style="display:none;color:var(--text-negative)"></div>'
    + '</div>'
    + '<div class="footer svelte-vywflk" id="recFooter"></div>'
    + '</div>';
  const inp = $('#recNumber');
  inp.addEventListener('input', () => formatPhoneInput(inp));
  $('#recFooter').innerHTML = footerPrimary('Восстановить', 'recSubmit')
    + '<button class="button button--link button--accent-tertiary svelte-kxwiet" type="button" id="recBack">Назад ко входу</button>';
  bindEyeButtons(root);
  $('#recBack').onclick = () => { authPhone = inp.value.replace(/\D/g, ''); renderAuthStep('number'); };
  $('#recSubmit').onclick = async () => {
    const number = inp.value.replace(/\D/g, '');
    const pass = $('#recPassword').value;
    if (number.length < 10) return setAuthError('Введите номер из 10 цифр');
    if (pass.length < 3) return setAuthError('Пароль от 3 символов');
    setAuthError('');
    try {
      const r = await api('/api/auth/recover', { method: 'POST', body: { number, password: pass } });
      showSnack('Пароль обновлён');
      enterApp(r.token, r.user);
    } catch (e) { setAuthError(e.message); }
  };
  setTimeout(() => inp.focus(), 0);
}

function enterApp(token, user) {
  S.token = token;
  S.me = user;
  localStorage.setItem('max_token', token);
  $('#authRoot').style.display = 'none';
  $('#recoveryRoot').style.display = 'none';
  $('#appRoot').style.display = 'grid';
  loadApp();
}

function logout() {
  if (S.es) { S.es.close(); S.es = null; }
  S.token = null;
  S.me = null;
  S.chats = [];
  S.messages = [];
  S.activeChatId = null;
  localStorage.removeItem('max_token');
  showAuth();
}

/* ------------------------------------------------------------ app shell */

function isMobile() { return window.matchMedia('(max-width: 925.9px)').matches; }

function enterMain() {
  if (isMobile()) {
    $('#appRoot').classList.add('app--mainActive');
    $('#mainEl').classList.add('main--active');
  }
}

function leaveMain() {
  $('#appRoot').classList.remove('app--mainActive');
  $('#mainEl').classList.remove('main--active');
}

function ensureTabbar() {
  const existing = $('#tabbarRoot');
  if (isMobile() && !existing) {
    const tb = h('<div class="tabbar svelte-1wa3uxr svelte-fqw3x2" id="tabbarRoot">'
      + '<button class="button button--tabbar svelte-xwrwgf" type="button" data-tab="chats">'
      + '<span class="icon svelte-xwrwgf">' + svgIcon('message', 24) + '</span>'
      + '<span class="title svelte-xwrwgf">Чаты</span></button>'
      + '<button class="button button--tabbar svelte-xwrwgf" type="button" data-tab="contacts">'
      + '<span class="icon svelte-xwrwgf">' + svgIcon('users', 24) + '</span>'
      + '<span class="title svelte-xwrwgf">Контакты</span></button>'
      + '<button class="button button--tabbar svelte-xwrwgf" type="button" data-tab="settings">'
      + '<span class="icon svelte-xwrwgf">' + svgIcon('settings', 24) + '</span>'
      + '<span class="title svelte-xwrwgf">Настройки</span></button></div>');
    $('#appRoot').appendChild(tb);
    $$('[data-tab]', tb).forEach((b) => {
      b.onclick = () => {
        const t = b.dataset.tab;
        if (t === 'chats') {
          showScreen(S.activeChatId ? 'chat' : 'placeholder');
          if (S.activeChatId) enterMain(); else leaveMain();
        } else {
          showScreen('generic', t);
          enterMain();
        }
        updateTabbarActive();
      };
    });
  }
  if (!isMobile() && existing) existing.remove();
}

function updateTabbarActive() {
  const tb = $('#tabbarRoot');
  if (!tb) return;
  $$('[data-tab]', tb).forEach((b) => {
    const t = b.dataset.tab;
    const active = (t === 'chats' && (S.screen === 'chat' || S.screen === 'placeholder'))
      || (t === 'settings' && S.screen === 'generic' && S.genericKind === 'settings')
      || (t === 'contacts' && S.screen === 'generic' && S.genericKind === 'contacts');
    b.classList.toggle('button--active', active);
  });
}

function showScreen(name, kind, isBack) {
  if (name === 'generic') {
    if (!isBack) {
      if (S.screen === 'generic') S.prevKind = S.genericKind;
      else { S.prevScreen = S.screen; S.prevKind = null; }
    }
  } else {
    S.prevKind = null;
  }
  S.screen = name;
  S.genericKind = kind || null;
  $('#screenPlaceholder').style.display = name === 'placeholder' ? '' : 'none';
  $('#screenChat').style.display = name === 'chat' ? '' : 'none';
  $('#screenGeneric').style.display = name === 'generic' ? '' : 'none';
  if (name === 'generic') buildGeneric(kind);
  updateTabbarActive();
}

function activeChat() {
  return S.chats.find((c) => c.id === S.activeChatId) || null;
}

/* -------------------------------------------------------- chats & folders */

function chatPreview(chat) {
  const m = chat.lastMessage;
  if (!m) return '';
  if (m.type === 'text') return m.text;
  if (m.type === 'sticker') return 'Стикер';
  if (m.type === 'voice') return 'Голосовое сообщение';
  if (m.type === 'video') return 'Видеосообщение';
  if (m.type === 'media') {
    if (m.text) return m.text;
    const last = (m.attachments || [])[(m.attachments || []).length - 1];
    if (last && last.type === 'video') return 'Видео';
    return 'Фото';
  }
  return m.text || '';
}

function folderMatch(chat) {
  if (S.folder === 'all') return true;
  if (S.folder === 'sferum') return chat.folder === 'sferum';
  if (S.folder === 'new') return chat.unread > 0;
  if (S.folder === 'channels') return !!(chat.peer && chat.peer.isChannel);
  return true;
}

function sortChats(list) {
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function userRowHtml(u) {
  return '<div class="cell cell--action cellBorderRadius-m svelte-143i7y" data-user="' + esc(u.number) + '" role="button">'
    + '<div class="before svelte-143i7y">' + avatarHtml(u, 40) + '</div>'
    + '<div class="content svelte-143i7y">'
    + '<span class="body-strong svelte-dvfghq weight-500 text-primary">' + esc(u.name || u.number) + '</span>'
    + '<span class="description svelte-dvfghq weight-400 text-tertiary">' + esc(u.number) + (u.isChannel ? ' · канал' : '') + '</span>'
    + '</div>'
    + '<div class="after svelte-143i7y">' + svgIcon('chevron_right', 16) + '</div>'
    + '<button class="overlay svelte-143i7y" tabindex="-1" type="button"></button></div>';
}

function renderChatList() {
  const box = $('#chatList');
  if (!box) return;
  const q = ($('#asideSearchInput').value || '').trim().toLowerCase();
  let chats = sortChats(S.chats.filter(folderMatch));
  if (q) {
    chats = chats.filter((c) => {
      const p = peerOf(c);
      return (p.name || '').toLowerCase().includes(q)
        || (p.number || '').includes(q.replace(/[^\d+]/g, ''))
        || chatPreview(c).toLowerCase().includes(q);
    });
  }
  let html = '';
  if (S.searchUsers && S.searchUsers.length) {
    html += '<div class="separator svelte-53vk3i">Люди</div>';
    html += '<div style="padding:0 8px 8px;">' + S.searchUsers.map(userRowHtml).join('') + '</div>';
    if (chats.length) html += '<div class="separator svelte-53vk3i">Чаты</div>';
  }
  if (!chats.length && !S.searchUsers) {
    html = '<div class="empty svelte-53vk3i" style="flex-direction:column;gap:12px;padding-bottom:48px;">'
      + '<div class="emptyIcon svelte-16cs9d">' + svgIcon('message', 32) + '</div>'
      + '<div class="hint svelte-1v23cz">' + (q ? 'Ничего не найдено' : 'Пока нет чатов') + '</div>'
      + '</div>';
  }
  html += chats.map(chatCellHtml).join('');
  box.innerHTML = html;

  $$('.item[data-chat]', box).forEach((item) => {
    const id = item.dataset.chat;
    $('.cell', item).onclick = () => openChat(id);
    const menuBtn = $('.menuButton', item);
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const r = menuBtn.getBoundingClientRect();
        openChatMenu(id, r.right, r.bottom + 4);
      };
    }
    item.oncontextmenu = (e) => {
      e.preventDefault();
      openChatMenu(id, e.clientX, e.clientY);
    };
  });
  $$('[data-user]', box).forEach((cell) => {
    cell.onclick = () => startChatWith(cell.dataset.user);
  });
}

function chatCellHtml(chat) {
  const p = peerOf(chat);
  const unread = chat.unread || 0;
  const selected = chat.id === S.activeChatId && S.screen === 'chat';
  return '<div class="item svelte-rg2upy" data-chat="' + esc(chat.id) + '">'
    + '<div role="presentation" class="wrapper wrapper--withActions svelte-q2jdqb">'
    + '<button class="cell svelte-q2jdqb' + (selected ? ' cell--selected' : '') + '" type="button">'
    + '<div class="avatar svelte-q2jdqb"><div class="avatarComposition svelte-1njcjnw">'
    + '<div class="avatar svelte-1gp4c0a" style="--avatarSize:64px;">'
    + avatarHtml(p, 64) + '</div></div></div>'
    + '<h3 class="title svelte-q2jdqb"><span class="name svelte-1riu5uh"><span class="text svelte-1riu5uh">'
    + esc(p.name || p.number) + '</span></span></h3>'
    + '<div class="indicators svelte-q2jdqb">'
    + (unread ? '<div class="indicator svelte-q2jdqb"><div class="badgeIcon badgeIcon--20 badgeIcon--themed-regular svelte-1bvrx6k">'
      + '<span class="text text--16 svelte-t2168e">' + (unread > 99 ? '99+' : unread) + '</span></div></div>' : '')
    + '</div>'
    + '<span class="text svelte-q2jdqb">' + esc(chatPreview(chat)) + '</span>'
    + '<div class="meta svelte-q2jdqb"><span class="time svelte-q2jdqb">'
    + (chat.lastMessage ? esc(fmtListTime(chat.lastMessage.ts)) : '') + '</span></div>'
    + '<div class="icons svelte-q2jdqb"></div>'
    + '</button>'
    + '<div class="actions svelte-q2jdqb"><button class="menuButton svelte-q2jdqb" aria-label="Еще" type="button">'
    + svgIcon('dots_horizontal_mini', 16) + '</button></div>'
    + '</div></div>';
}

function openChatMenu(id, x, y) {
  const chat = S.chats.find((c) => c.id === id);
  if (!chat) return;
  const inSferum = chat.folder === 'sferum';
  showMenu([
    {
      label: inSferum ? 'Убрать из Сферума' : 'Добавить в Сферум',
      icon: 'folder',
      onClick: async () => {
        try {
          await api('/api/chats/' + id + '/folder', { method: 'POST', body: { folder: inSferum ? null : 'sferum' } });
          chat.folder = inSferum ? null : 'sferum';
          renderChatList();
          updateNavCounters();
        } catch (e) { showSnack(e.message); }
      },
    },
    {
      label: 'Удалить чат',
      icon: 'delete',
      danger: true,
      onClick: () => confirmDialog('Удалить чат?', 'История сообщений будет скрыта только у вас.', 'Удалить', true, async () => {
        try {
          await api('/api/chats/' + id, { method: 'DELETE' });
          S.chats = S.chats.filter((c) => c.id !== id);
          if (S.activeChatId === id) {
            S.activeChatId = null;
            S.messages = [];
            showScreen('placeholder');
            leaveMain();
          }
          renderChatList();
          updateNavCounters();
          showSnack('Чат удалён');
        } catch (e) { showSnack(e.message); }
      }),
    },
  ], x, y);
}

async function startChatWith(number) {
  try {
    const r = await api('/api/chats', { method: 'POST', body: { peerNumber: number } });
    upsertChat(r.chat);
    closeDialog();
    openChat(r.chat.id);
  } catch (e) { showSnack(e.message); }
}

function upsertChat(chat) {
  if (!chat || !chat.id) return;
  const i = S.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) S.chats[i] = Object.assign({}, S.chats[i], chat);
  else S.chats.push(chat);
  renderChatList();
  updateNavCounters();
}

function updateNavCounters() {
  const counts = { all: 0, sferum: 0, new: 0, channels: 0 };
  for (const c of S.chats) {
    const u = c.unread || 0;
    if (!u) continue;
    counts.all += u;
    if (c.folder === 'sferum') counts.sferum += u;
    if (c.peer && c.peer.isChannel) counts.channels += u;
    counts.new += 1;
  }
  const map = { all: 'folder-all-counter', sferum: 'folder-sferum-counter', new: 'folder-new-counter', channels: 'folder-channels-counter' };
  for (const key of Object.keys(map)) {
    const el = document.getElementById(map[key]);
    if (!el) continue;
    const n = counts[key];
    if (n > 0) {
      const themed = (key === 'new') ? 'quaternary' : 'themed';
      el.innerHTML = '<div class="badgeIcon badgeIcon--16 badgeIcon--' + themed + '-regular svelte-1bvrx6k" aria-hidden="true">'
        + '<span class="text text--16 svelte-t2168e">' + (n > 99 ? '99+' : n) + '</span></div>';
      el.setAttribute('aria-label', ', непрочитанных чатов ' + n);
    } else {
      el.innerHTML = '';
      el.setAttribute('aria-label', 'непрочитанных чатов');
    }
  }
}

/* ----------------------------------------------------------- SSE events */

function connectSSE() {
  if (S.es) { S.es.close(); S.es = null; }
  const es = new EventSource('/api/events?token=' + encodeURIComponent(S.token));
  S.es = es;
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (err) { return; }
    handleEvent(ev);
  };
  es.onerror = () => { /* auto-reconnect */ };
}

function handleEvent(ev) {
  if (!ev || !ev.event) return;
  switch (ev.event) {
    case 'presence': {
      S.online[ev.number] = !!ev.online;
      if (S.screen === 'chat') updateTopbarSubtitle();
      break;
    }
    case 'user': {
      const u = ev.user;
      if (!u) break;
      S.online[u.number] = !!u.online;
      if (S.me && u.number === S.me.number) {
        S.me = Object.assign({}, S.me, u);
        renderGenericIfVisible();
      }
      for (const c of S.chats) {
        if (c.peer && c.peer.number === u.number) {
          c.peer = Object.assign({}, c.peer, u);
        }
      }
      renderChatList();
      if (S.screen === 'chat') updateTopbarForChat();
      renderGenericIfVisible();
      break;
    }
    case 'chat': {
      if (ev.chat && ev.chat.id) upsertChat(ev.chat);
      break;
    }
    case 'chat-deleted': {
      S.chats = S.chats.filter((c) => c.id !== ev.chatId);
      if (S.activeChatId === ev.chatId) {
        S.activeChatId = null;
        S.messages = [];
        showScreen('placeholder');
        leaveMain();
      }
      renderChatList();
      updateNavCounters();
      break;
    }
    case 'message': onIncomingMessage(ev); break;
    case 'read': {
      if (ev.by !== (S.me && S.me.number)) break;
      const chat = S.chats.find((c) => c.id === ev.chatId);
      const peerNum = chat ? peerOf(chat).number : null;
      for (const m of S.messages) {
        if (m.from === S.me.number && peerNum && !m.readBy.includes(peerNum)) m.readBy.push(peerNum);
      }
      if (S.screen === 'chat' && ev.chatId === S.activeChatId) refreshIndicators();
      break;
    }
    case 'typing': {
      if (ev.by === (S.me && S.me.number)) break;
      if (ev.chatId !== S.activeChatId) break;
      S.typing[ev.by] = Date.now() + 5000;
      updateTopbarSubtitle();
      break;
    }
    case 'message-updated': {
      const i = S.messages.findIndex((m) => m.id === ev.message.id);
      if (i >= 0) {
        S.messages[i] = ev.message;
        if (S.screen === 'chat' && ev.chatId === S.activeChatId) renderMessages();
      }
      break;
    }
    case 'message-deleted': {
      S.messages = S.messages.filter((m) => m.id !== ev.messageId);
      if (S.screen === 'chat' && ev.chatId === S.activeChatId) renderMessages();
      if (ev.chat) upsertChat(ev.chat);
      break;
    }
    case 'call:incoming': onCallIncoming(ev.call); break;
    case 'call:accepted': onCallAccepted(ev.call); break;
    case 'call:ended': onCallEnded(ev.call); break;
    default: break;
  }
}

function onIncomingMessage(ev) {
  const chat = ev.chat || S.chats.find((c) => c.id === ev.chatId);
  if (chat) upsertChat(Object.assign({}, chat, { id: ev.chatId }));
  const isActive = S.screen === 'chat' && ev.chatId === S.activeChatId;
  const mine = S.me && ev.message && ev.message.from === S.me.number;
  if (isActive) {
    if (!S.messages.find((m) => m.id === ev.message.id)) S.messages.push(ev.message);
    const scroller = $('#historyScroll');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    renderMessages();
    if (mine || atBottom) {
      scrollToBottom(true);
      S.unreadBelow = 0;
    } else if (!mine) {
      S.unreadBelow += 1;
      updateScrollFab();
    }
    if (!mine) api('/api/chats/' + ev.chatId + '/read', { method: 'POST' }).catch(() => {});
    updateChatUnread(ev.chatId, 0);
  } else if (!mine) {
    // keep list badge fresh even if summary was not provided
    const c = S.chats.find((x) => x.id === ev.chatId);
    if (c) { c.unread = (c.unread || 0) + 1; renderChatList(); updateNavCounters(); }
  }
}

function updateChatUnread(chatId, n) {
  const c = S.chats.find((x) => x.id === chatId);
  if (c) { c.unread = n; renderChatList(); updateNavCounters(); }
}

function renderGenericIfVisible() {
  if (S.screen === 'generic') buildGeneric(S.genericKind);
}

/* ---------------------------------------------------------- open a chat */

function scrollToBottom(instant) {
  const scroller = $('#historyScroll');
  scroller.scrollTop = scroller.scrollHeight;
  if (instant) updateStickyDate();
}

async function openChat(id) {
  const chat = S.chats.find((c) => c.id === id);
  if (!chat) return;
  S.activeChatId = id;
  S.replyTo = null;
  renderComposerQuote();
  clearChatSearch();
  showScreen('chat');
  enterMain();
  updateTopbarForChat();
  updateScrollFab();
  try {
    const r = await api('/api/chats/' + id + '/messages');
    S.messages = r.messages || [];
    renderMessages();
    scrollToBottom(true);
    updateChatUnread(id, 0);
    api('/api/chats/' + id + '/read', { method: 'POST' }).catch(() => {});
    renderChatList();
  } catch (e) {
    showSnack(e.message);
  }
}

function goBackFromChat() {
  if (isMobile()) {
    leaveMain();
    showScreen('placeholder');
  } else {
    showScreen('placeholder');
  }
  renderChatList();
}

/* --------------------------------------------------------------- topbar */

function updateTopbarForChat() {
  const chat = activeChat();
  if (!chat) return;
  const p = peerOf(chat);
  const btn = $('#topbarMainBtn');
  btn.setAttribute('aria-label', 'Открыть профиль ' + (p.name || ''));
  const ph = $('.image-placeholder', btn);
  if (ph) {
    ph.innerHTML = avatarInner(p, 40);
    ph.style.cssText = 'width:40px;height:40px;display:inline-block;position:relative;';
  }
  const content = $('.content', btn);
  const title = $('.title', btn);
  if (title) title.textContent = p.name || p.number;
  const subtitle = $('.subtitle', btn);
  if (subtitle && content) {
    const text = subtitleText(chat);
    subtitle.textContent = text;
    content.classList.toggle('content--subtitle', !!text);
    const wrap = $('.subtitleWrapper', btn);
    if (wrap) wrap.style.display = text ? '' : 'none';
  }
  $('#mainHeaderTitle').textContent = p.name || 'Чат';
}

function subtitleText(chat) {
  const p = peerOf(chat);
  if (S.typing[p.number] && S.typing[p.number] > Date.now()) return 'печатает…';
  if (peerOnline(chat)) return 'в сети';
  return '';
}

function updateTopbarSubtitle() {
  if (S.screen !== 'chat') return;
  const chat = activeChat();
  if (!chat) return;
  const btn = $('#topbarMainBtn');
  const content = $('.content', btn);
  const subtitle = $('.subtitle', btn);
  if (!subtitle || !content) return;
  const text = subtitleText(chat);
  subtitle.textContent = text;
  content.classList.toggle('content--subtitle', !!text);
  const wrap = $('.subtitleWrapper', btn);
  if (wrap) wrap.style.display = text ? '' : 'none';
}

function refreshIndicators() {
  if (S.screen !== 'chat') return;
  const chat = activeChat();
  if (!chat) return;
  const peerNum = peerOf(chat).number;
  $$('#historyContent [data-msg]').forEach((block) => {
    const m = S.messages.find((x) => x.id === block.dataset.msg);
    if (!m || m.from !== S.me.number) return;
    const ind = $('.indicators', block);
    if (ind) ind.innerHTML = svgIcon(m.readBy.includes(peerNum) ? 'status_read' : 'status_delivered', 16);
  });
}

/* ------------------------------------------------------------ rendering */

function reactionsHtml(m, out) {
  const r = m.reactions || {};
  const keys = Object.keys(r).filter((k) => (r[k] || []).length);
  if (!keys.length) return '';
  const myNum = S.me.number;
  const pills = keys.map((emoji) => {
    const arr = r[emoji] || [];
    const mine = arr.includes(myNum);
    return '<button class="reaction svelte-1ug033e' + (mine ? ' reaction--active' : '') + '" data-react="'
      + esc(emoji) + '" type="button"><span>' + esc(emoji) + '</span>'
      + (arr.length > 1 ? '<span class="counter svelte-1ug033e">' + arr.length + '</span>' : '') + '</button>';
  }).join('');
  return '<div class="reactions svelte-1htnb3l"><div class="reactions svelte-xkv7l2">' + pills + '</div></div>';
}

function metaHtml(m, out, extraClass) {
  const chat = activeChat();
  const peerNum = chat ? peerOf(chat).number : null;
  const read = out && peerNum && m.readBy.includes(peerNum);
  const ind = out ? '<div class="indicators svelte-13lobfv">'
    + svgIcon(read ? 'status_read' : 'status_delivered', 16) + '</div>' : '';
  return '<div data-message-double-click-ignore="" class="meta meta--text ' + (extraClass || '') + ' svelte-13lobfv">'
    + '<span class="text svelte-13lobfv" role="button" tabindex="0">' + fmtTime(m.ts) + '</span>'
    + ind + '</div>';
}

function replyQuoteHtml(reply, inComposer) {
  const name = esc(numberName(reply.from));
  const text = esc(reply.text || '');
  if (inComposer) {
    return '<span class="quoteText svelte-afc7v9"><span style="color:var(--bubbles-text-action);">'
      + name + '</span>' + (text ? '\n' + text : '') + '</span>';
  }
  return '<div class="wrapper svelte-14o191i"><div class="quote svelte-14o191i" data-jump="'
    + esc(reply.id) + '">' + replyQuoteHtml(reply, true)
    + '<svg class="quoteIcon svelte-14o191i" width="12" height="12"><use href="#icon_reply"></use></svg>'
    + '</div></div>';
}

function gridLayout(items) {
  const G = 2;
  const W = 400;
  const n = items.length;
  const tiles = [];
  let H;
  if (n === 1) {
    const it = items[0];
    H = Math.max(160, Math.min(520, Math.round(W * (it.h || 300) / (it.w || 400))));
    tiles.push({ x: 0, y: 0, w: W, h: H });
  } else if (n === 2) {
    H = 200;
    const w = (W - G) / 2;
    tiles.push({ x: 0, y: 0, w, h: 200 }, { x: w + G, y: 0, w, h: 200 });
  } else if (n === 3) {
    H = 200 + G + 199;
    const w = (W - G) / 2;
    tiles.push({ x: 0, y: 0, w: W, h: 200 },
      { x: 0, y: 200 + G, w, h: 199 },
      { x: w + G, y: 200 + G, w, h: 199 });
  } else {
    H = 199 + G + 199;
    const w = (W - G) / 2;
    tiles.push({ x: 0, y: 0, w, h: 199 },
      { x: w + G, y: 0, w, h: 199 },
      { x: 0, y: 199 + G, w, h: 199 },
      { x: w + G, y: 199 + G, w, h: 199 });
  }
  return { w: W, h: H, tiles };
}

function mediaHtml(m) {
  const items = (m.attachments || []).filter((a) => a.url);
  if (!items.length) return '';
  const lay = gridLayout(items);
  const shown = lay.tiles.slice(0, items.length);
  const extra = items.length - shown.length;
  const tiles = shown.map((t, i) => {
    const a = items[i];
    let inner;
    if (a.type === 'video') {
      inner = '<video class="player svelte-ti8mxv player--cover" src="' + esc(a.url) + '" preload="metadata" playsinline muted></video>';
    } else {
      inner = '<img class="img svelte-1aizpza" src="' + esc(a.url) + '" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;">';
    }
    const badge = (i === shown.length - 1 && extra > 0)
      ? '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#00000066;">'
      + '<div class="mediaCapsule svelte-wj4jng">+' + extra + '</div></div>' : '';
    return '<button class="tile svelte-1czsaa1" type="button" data-zoom="' + esc(a.url) + '" data-zoom-type="' + esc(a.type) + '"'
      + ' style="left:' + t.x + 'px;top:' + t.y + 'px;width:' + t.w + 'px;height:' + t.h + 'px;">'
      + inner + badge + '</button>';
  }).join('');
  return '<div class="media svelte-1htnb3l"><div class="grid svelte-1czsaa1" style="width:' + lay.w
    + 'px;height:' + lay.h + 'px;">' + tiles + '</div></div>';
}

function voicePeaks(m) {
  const seed = String(m.id);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const n = 44;
  let peaks = '';
  for (let i = 0; i < n; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    const hgt = 4 + (hash % 17);
    peaks += '<div class="peak svelte-1z4eq2" style="height:' + hgt + 'px"></div>';
  }
  return peaks;
}

function voiceHtml(m) {
  const dur = fmtDuration(m.duration);
  return '<div class="attachAudio svelte-15vy73c">'
    + '<div class="buttonWrapper svelte-15vy73c"><button class="button svelte-15vy73c" type="button" data-voice="'
    + esc(m.id) + '" data-url="' + esc(m.url || '') + '">' + svgIcon('play_fill', 20) + '</button></div>'
    + '<div class="content svelte-15vy73c">'
    + '<div class="waveWrapper waveWrapper--seekable svelte-15vy73c" style="flex:1">'
    + '<div class="wave svelte-1z4eq2" style="--peak-width:3px;--peak-gap:2px;">' + voicePeaks(m) + '</div></div>'
    + '<span class="duration svelte-15vy73c">' + dur + '</span>'
    + '</div>'
    + '<div class="meta svelte-15vy73c">' + metaHtml(m, m.from === (S.me && S.me.number)) + '</div>'
    + '</div>';
}

function videoMessageHtml(m) {
  return '<div class="videoMessage svelte-2z8dlw" style="width:240px;">'
    + '<div class="player svelte-2z8dlw" style="width:240px;height:240px;">'
    + '<video src="' + esc(m.url || '') + '" preload="metadata" playsinline controls'
    + ' style="width:240px;height:240px;object-fit:cover;border-radius:50%;display:block;"></video>'
    + '</div></div>';
}

function messageBodyHtml(m, opts) {
  const out = opts.out;
  const side = out ? 'right' : 'left';
  const pos = opts.pos;
  const metaW = out ? 47 : 29;
  const wrapCls = 'bordersWrapper bordersWrapper--' + pos + '--' + side + ' svelte-1htnb3l';
  let bubbleCls = 'bubble svelte-1htnb3l';
  let inner = '';
  const reply = m.replyTo ? replyQuoteHtml(m.replyTo, false) : '';

  if (m.type === 'text' || (m.type === 'media' && m.text)) {
    // handled below in composite
  }

  if (m.type === 'sticker') {
    bubbleCls += ' bubble--hideBackground';
    inner = '<div class="contentWithMeta svelte-1htnb3l">'
      + reply
      + '<span class="sticker svelte-1htnb3l"><img src="' + esc(m.url || ((m.attachments || [])[0] || {}).url || '')
      + '" alt="" draggable="false" style="width:160px;height:160px;object-fit:contain;"></span>'
      + '<span class="meta svelte-1htnb3l">' + metaHtml(m, out, 'meta--bubbled-outside') + '</span>'
      + '</div>';
    return wrap(bubbleCls, inner, true);
  }

  if (m.type === 'voice') {
    inner = reply + '<div class="attachAudioWrap">' + voiceHtml(m) + '</div>';
    // attachAudio carries its own meta; keep reply above it
    if (reply) {
      return wrap(bubbleCls, reply + voiceHtml(m), false);
    }
    return wrap(bubbleCls, voiceHtml(m), false);
  }

  if (m.type === 'video') {
    inner = '<div class="contentWithMeta svelte-1htnb3l">'
      + reply + videoMessageHtml(m)
      + '<span class="meta svelte-1htnb3l">' + metaHtml(m, out, 'meta--bubbled-outside') + '</span>'
      + '</div>';
    return wrap(bubbleCls, inner, true);
  }

  if (m.type === 'media') {
    inner = '<div class="contentWithMeta svelte-1htnb3l">'
      + reply + mediaHtml(m)
      + (m.text ? '<span class="text svelte-1htnb3l">' + esc(m.text) + '</span>' : '')
      + '<span class="meta svelte-1htnb3l">' + metaHtml(m, out, 'meta--bubbled-outside') + '</span>'
      + '</div>';
    return wrap(bubbleCls, inner, true);
  }

  // plain text
  const isEmoji = /^\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic})*$/u.test((m.text || '').trim());
  inner = reply
    + '<span class="text svelte-1htnb3l' + (isEmoji ? ' emojis' : '') + '" data-message-markup="" data-message-double-click-ignore="">'
    + esc(m.text || '') + '</span>'
    + '<span class="meta svelte-1htnb3l">' + metaHtml(m, out) + '</span>';
  return wrap(bubbleCls, inner, false);

  function wrap(cls, content, noOverflow) {
    const wcls = noOverflow
      ? 'bordersWrapper bordersWrapper--noOverflow bordersWrapper--noOverflow--' + side + ' svelte-1htnb3l'
      : 'bordersWrapper bordersWrapper--' + pos + '--' + side + ' svelte-1htnb3l';
    return '<div class="' + wcls + '"><div class="' + cls + '"><div class="bubbleContent svelte-1htnb3l">'
      + content + '</div></div></div>';
  }
}

function blockHtml(m, opts) {
  const out = opts.out;
  const wrapperCls = ['messageWrapper',
    out ? 'messageWrapper--isOut' : '',
    opts.first ? 'messageWrapper--first' : '',
    opts.last ? 'messageWrapper--last' : ''].filter(Boolean).join(' ');
  const metaW = out ? 47 : 29;
  const body = messageBodyHtml(m, { out, pos: opts.pos });
  const reactions = reactionsHtml(m, out);
  return '<div role="listitem" class="block svelte-1kh0oxy" style="padding:0 16px;" data-msg="' + esc(m.id)
    + '" data-search="' + esc(((m.text || '') + ' ' + chatPreview({ lastMessage: m })).toLowerCase()) + '">'
    + '<div role="presentation" class="' + wrapperCls + ' svelte-1kh0oxy">'
    + '<div role="presentation" class="message svelte-1kh0oxy" style="max-width:70%;">'
    + '<div class="message' + (out ? ' message--isOut' : '') + ' svelte-1htnb3l" style="max-width:100%;--metaWidth:'
    + metaW + 'px;--metaHeight:16px;">'
    + '<div data-bubbles-variant="' + (out ? 'outgoing' : 'incoming') + '">'
    + body + reactions
    + '</div></div></div>'
    + '<div class="messageControls svelte-1kh0oxy" style="display:none;">'
    + '<div class="wrapper svelte-k89anl' + (out ? ' wrapper--out' : '') + '">'
    + '<div class="buttons svelte-k89anl' + (out ? ' buttons--out' : '') + '">'
    + '<div class="row svelte-k89anl">'
    + '<button class="button svelte-k89anl" type="button" data-act="reply" aria-label="Ответить">' + svgIcon('reply', 16) + '</button>'
    + '<button class="button svelte-k89anl" type="button" data-act="react" aria-label="Реакция"><span style="font-size:14px;line-height:1">😊</span></button>'
    + '</div></div></div></div>'
    + '<div class="reactionsSlot svelte-1npybpi" style="display:none;">'
    + '<div class="reactions svelte-1wr46wy">'
    + ['👍', '❤️', '😂', '😮', '😢', '😡', '👎', '🎉', '🔥', '🙏'].map((e) =>
      '<button class="reaction svelte-plrlbx" type="button" data-pick="' + e + '"><span style="font-size:18px;line-height:1">' + e + '</span></button>').join('')
    + '</div></div>'
    + '</div></div>';
}

function daySeparatorHtml(ts) {
  return '<div class="capsuleSeparator capsuleSeparator--first svelte-3850xr"><span class="capsule svelte-3850xr">'
    + esc(fmtDaySeparator(ts)) + '</span></div>';
}

function unreadSeparatorHtml() {
  return '<div class="unreadSeparator unreadSeparator--first svelte-3850xr">Непрочитанные сообщения</div>';
}

function renderMessages() {
  const box = $('#historyContent');
  const msgs = S.messages;
  const me = S.me && S.me.number;
  const chat = activeChat();
  let html = '';
  let unreadPlaced = false;
  const showUnread = !!(chat && chat.unread > 0);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const day = dayKey(m.ts);
    if (!prev || dayKey(prev.ts) !== day) html += daySeparatorHtml(m.ts);

    const incoming = m.from !== me;
    if (showUnread && incoming && !unreadPlaced && !(m.readBy || []).includes(me)) {
      html += unreadSeparatorHtml();
      unreadPlaced = true;
    }

    const groupPrev = !!prev && prev.from === m.from && dayKey(prev.ts) === day && (m.ts - prev.ts) < 5 * 60 * 1000;
    const groupNext = !!next && next.from === m.from && dayKey(next.ts) === day && (next.ts - m.ts) < 5 * 60 * 1000;
    const first = !groupPrev;
    const last = !groupNext;
    const pos = (first && last) ? 'undefined' : first ? 'upper' : last ? 'bottom' : 'middle';
    html += blockHtml(m, { out: m.from === me, first, last, pos });
  }

  if (!msgs.length) {
    html = '<div class="empty svelte-53vk3i" style="flex-direction:column;gap:12px;">'
      + '<div class="hint svelte-1v23cz">Сообщений пока нет<br>Напишите первое сообщение</div></div>';
  }
  box.innerHTML = html;
  bindHistoryEvents();
  updateStickyDate();
}

/* ------------------------------------------------------- history events */

function bindHistoryEvents() {
  const box = $('#historyContent');

  box.oncontextmenu = (e) => {
    const block = e.target.closest('[data-msg]');
    if (!block) return;
    e.preventDefault();
    const m = S.messages.find((x) => x.id === block.dataset.msg);
    if (!m) return;
    const items = [
      { label: 'Ответить', icon: 'reply', onClick: () => setReply(m) },
      { label: 'Копировать', icon: 'copy', onClick: () => copyMessage(m) },
      { label: 'Реакция', icon: 'send', onClick: () => openPickerFor(block) },
    ];
    if (m.from === (S.me && S.me.number)) {
      items.push({
        label: 'Удалить', icon: 'delete', danger: true,
        onClick: () => confirmDialog('Удалить сообщение?', null, 'Удалить', true, async () => {
          try {
            await api('/api/chats/' + S.activeChatId + '/messages/' + m.id, { method: 'DELETE' });
            S.messages = S.messages.filter((x) => x.id !== m.id);
            renderMessages();
          } catch (err) { showSnack(err.message); }
        }),
      });
    }
    showMenu(items, e.clientX, e.clientY);
  };

  $$('.messageWrapper', box).forEach((wrapEl) => {
    const controls = $('.messageControls', wrapEl);
    if (!controls) return;
    wrapEl.addEventListener('mouseenter', () => { controls.style.display = 'flex'; });
    wrapEl.addEventListener('mouseleave', () => {
      const slot = $('.reactionsSlot', wrapEl);
      const pickerOpen = slot && slot.style.display !== 'none' && slot.matches(':hover');
      if (!pickerOpen) controls.style.display = 'none';
      if (slot && !slot.matches(':hover')) slot.style.display = 'none';
    });
  });

  $$('[data-act=reply]', box).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const block = b.closest('[data-msg]');
      const m = S.messages.find((x) => x.id === block.dataset.msg);
      if (m) setReply(m);
    };
  });

  $$('[data-act=react]', box).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openPickerFor(b.closest('[data-msg]'));
    };
  });

  $$('.reactionsSlot', box).forEach((slot) => {
    slot.addEventListener('mouseleave', () => { slot.style.display = 'none'; });
    $$('[data-pick]', slot).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const block = slot.closest('[data-msg]');
        slot.style.display = 'none';
        reactTo(block.dataset.msg, btn.dataset.pick);
      };
    });
  });

  $$('[data-react]', box).forEach((pill) => {
    pill.onclick = (e) => {
      e.stopPropagation();
      const block = pill.closest('[data-msg]');
      reactTo(block.dataset.msg, pill.dataset.react);
    };
  });

  $$('.quote[data-jump]', box).forEach((q) => {
    q.onclick = (e) => {
      e.stopPropagation();
      jumpToMessage(q.dataset.jump);
    };
  });

  $$('[data-zoom]', box).forEach((tile) => {
    tile.onclick = () => openZoom(tile.dataset.zoom, tile.dataset.zoomType);
  });

  $$('[data-voice]', box).forEach((btn) => {
    btn.onclick = () => toggleVoice(btn);
  });
}

function openPickerFor(block) {
  if (!block) return;
  const slot = $('.reactionsSlot', block);
  if (!slot) return;
  slot.style.display = 'block';
}

async function reactTo(msgId, emoji) {
  try {
    const r = await api('/api/chats/' + S.activeChatId + '/messages/' + msgId + '/react',
      { method: 'POST', body: { emoji } });
    const i = S.messages.findIndex((m) => m.id === msgId);
    if (i >= 0) S.messages[i] = r.message;
    renderMessages();
  } catch (e) { showSnack(e.message); }
}

function copyMessage(m) {
  const text = m.text || chatPreview({ lastMessage: m });
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showSnack('Скопировано')).catch(() => showSnack('Не удалось скопировать'));
  else showSnack('Не удалось скопировать');
}

function jumpToMessage(id) {
  const block = $('#historyContent [data-msg="' + id + '"]');
  if (!block) { showSnack('Сообщение удалено'); return; }
  block.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const bubble = $('.bubble', block);
  if (bubble) {
    bubble.classList.add('bubble--highlighted');
    setTimeout(() => bubble.classList.remove('bubble--highlighted'), 1400);
  }
}

/* ------------------------------------------------------------ zoom view */

function openZoom(url, type) {
  const isVideo = type === 'video';
  const el = openDialog(
    '<div class="zoomContainer svelte-1giy9ku" id="zoomBox" style="width:min(92vw,1100px);height:min(86vh,800px);">'
    + '<div class="zoomMover svelte-1giy9ku" id="zoomMover">'
    + '<div class="zoomContent svelte-1giy9ku">'
    + (isVideo
      ? '<video src="' + esc(url) + '" controls autoplay style="max-width:92vw;max-height:86vh;"></video>'
      : '<img src="' + esc(url) + '" alt="" style="max-width:92vw;max-height:86vh;object-fit:contain;">')
    + '</div></div></div>'
    + '<div style="position:absolute;top:12px;right:12px;">'
    + '<button class="button button--small button--overlay svelte-1aw1384" id="zoomClose" type="button">'
    + '<div class="content svelte-1aw1384">' + svgIcon('cross', 20) + '</div></button></div>'
  );
  $('#zoomClose', el).onclick = closeDialog;
  const mover = $('#zoomMover', el);
  let scale = 1, tx = 0, ty = 0, drag = null;
  const apply = () => { mover.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const box = $('#zoomBox', el);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(0.5, Math.min(6, scale * (e.deltaY < 0 ? 1.15 : 0.87)));
    apply();
  }, { passive: false });
  box.addEventListener('mousedown', (e) => {
    if (e.target.closest('video')) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    mover.classList.add('zoomMover--dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    apply();
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    mover.classList.remove('zoomMover--dragging');
  });
}

/* --------------------------------------------------------------- reply */

function setReply(m) {
  S.replyTo = { id: m.id, from: m.from, text: (m.text || chatPreview({ lastMessage: m })).slice(0, 300) };
  renderComposerQuote();
  $('#editor').focus();
}

function renderComposerQuote() {
  const input = $('.input.svelte-1k31az8');
  if (!input) return;
  let q = $('#composerQuote');
  if (!S.replyTo) {
    if (q) q.remove();
    return;
  }
  if (!q) {
    q = h('<div class="quote" id="composerQuote" style="display:block;position:relative;"></div>');
    input.insertBefore(q, input.firstChild);
  }
  q.innerHTML = replyQuoteHtml(S.replyTo, true)
    + '<svg id="quoteCancel" width="12" height="12" style="cursor:pointer"><use href="#icon_cross_mini"></use></svg>';
  $('#quoteCancel', q).onclick = (e) => {
    e.stopPropagation();
    S.replyTo = null;
    renderComposerQuote();
  };
}

/* ------------------------------------------------------------- composer */

function editorText() {
  const ed = $('#editor');
  const raw = ed.innerText != null ? ed.innerText : (ed.textContent || '');
  return String(raw).replace(/\u00a0/g, ' ').replace(/\n+$/, '');
}

function clearEditor() {
  $('#editor').innerHTML = '<p class="paragraph" dir="auto"><br></p>';
  updatePlaceholder();
}

function updatePlaceholder() {
  const ph = $('.placeholder.svelte-1k31az8');
  if (ph) ph.style.display = editorText().trim() ? 'none' : '';
}

async function sendText() {
  const text = editorText().trim();
  if (!text) return;
  const payload = { type: 'text', text };
  if (S.replyTo) payload.replyTo = S.replyTo;
  clearEditor();
  S.replyTo = null;
  renderComposerQuote();
  await sendMessage(payload);
}

async function sendMessage(payload) {
  if (!S.activeChatId) return;
  try {
    const r = await api('/api/chats/' + S.activeChatId + '/messages', { method: 'POST', body: payload });
    upsertLocalMessage(r.message);
  } catch (e) { showSnack(e.message); }
}

function upsertLocalMessage(msg) {
  if (!S.messages.find((m) => m.id === msg.id)) S.messages.push(msg);
  const chat = activeChat();
  if (chat) {
    chat.lastMessage = msg;
    chat.updatedAt = msg.ts;
    chat.unread = 0;
  }
  S.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  renderMessages();
  renderChatList();
  updateNavCounters();
  scrollToBottom(true);
}

function sendTyping() {
  if (!S.activeChatId) return;
  const now = Date.now();
  if (now - S.typingLastSent < 3000) return;
  S.typingLastSent = now;
  api('/api/chats/' + S.activeChatId + '/typing', { method: 'POST', body: { isTyping: true } }).catch(() => {});
}

/* --------------------------------------------------------- file sending */

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function imageDims(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = url;
  });
}

async function sendFiles(files) {
  const list = Array.from(files || []).slice(0, 10);
  if (!list.length) return;
  const attachments = [];
  let caption = editorText().trim();
  for (const f of list) {
    try {
      const data = await fileToDataUrl(f);
      if (f.type.startsWith('image/')) {
        const dims = await imageDims(data);
        const up = await api('/api/upload', { method: 'POST', body: { data } });
        attachments.push({ type: 'image', url: up.url, w: dims.w, h: dims.h });
      } else if (f.type.startsWith('video/')) {
        const up = await api('/api/upload', { method: 'POST', body: { data } });
        attachments.push({ type: 'video', url: up.url, w: 400, h: 400 });
      } else if (f.type.startsWith('audio/')) {
        const up = await api('/api/upload', { method: 'POST', body: { data } });
        await sendMessage({ type: 'voice', url: up.url, duration: 0 });
      } else {
        showSnack('Формат не поддерживается: ' + f.name);
      }
    } catch (e) {
      showSnack(e.message);
    }
  }
  if (attachments.length) {
    const payload = { type: 'media', attachments, text: caption };
    if (S.replyTo) payload.replyTo = S.replyTo;
    S.replyTo = null;
    renderComposerQuote();
    if (caption) clearEditor();
    await sendMessage(payload);
  }
}

/* ------------------------------------------------- sticker / emoji panel */

const STICKERS = ['/img/1F44D_32.webp', '/img/1F644_32.webp', '/img/1F680_32.webp'];
const EMOJI_SET = ['😀', '😂', '😍', '😎', '🥳', '😭', '😡', '🤔', '🙄', '😴',
  '👍', '👎', '👌', '🙏', '💪', '🔥', '❤️', '🎉', '✨', '🌹',
  '☕', '🍕', '⚽', '🎮', '🎵', '🚀', '🌈', '⭐', '💯', '😇'];

function toggleStickerPanel() {
  let panel = $('#stickerPanel');
  if (panel) {
    panel.remove();
    return;
  }
  panel = h('<div class="stickersMenu svelte-nwz8cp" id="stickerPanel" style="position:absolute;bottom:calc(100% + 8px);right:16px;display:flex;flex-direction:column;padding:12px;gap:8px;overflow:auto;"></div>');
  panel.innerHTML =
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + STICKERS.map((s) => '<button type="button" data-sticker="' + s + '" style="background:none;border:none;padding:4px;cursor:pointer;border-radius:12px;">'
      + '<img src="' + s + '" alt="" draggable="false" style="width:64px;height:64px;object-fit:contain;"></button>').join('')
    + '</div>'
    + '<div class="separator svelte-174ybgs" style="margin:4px 0;"></div>'
    + '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;">'
    + EMOJI_SET.map((e) => '<button type="button" data-emoji="' + e + '" style="background:none;border:none;padding:8px 0;cursor:pointer;font-size:22px;border-radius:8px;">' + e + '</button>').join('')
    + '</div>';
  const composerRoot = $('.composerBarContainer.svelte-17fi2hf');
  composerRoot.style.position = 'relative';
  composerRoot.appendChild(panel);
  $$('[data-sticker]', panel).forEach((b) => {
    b.onclick = async () => {
      panel.remove();
      await sendMessage({ type: 'sticker', url: b.dataset.sticker });
    };
  });
  $$('[data-emoji]', panel).forEach((b) => {
    b.onclick = () => {
      const ed = $('#editor');
      ed.focus();
      document.execCommand('insertText', false, b.dataset.emoji);
      updatePlaceholder();
    };
  });
  setTimeout(() => {
    const closer = (e) => {
      if (!panel.contains(e.target) && !$('#stickerBtn').contains(e.target)) {
        panel.remove();
        document.removeEventListener('mousedown', closer);
      }
    };
    document.addEventListener('mousedown', closer);
  }, 0);
}

/* -------------------------------------------------------- voice / video */

let mediaRecorder = null;
let recordChunks = [];
let recordStream = null;
let recordTimer = null;
let recordMaxTimer = null;
let recordStarted = 0;
let recordKind = null;
let analyser = null;

function stopRecording(send) {
  if (!mediaRecorder) return;
  const kind = recordKind;
  const duration = Math.round((Date.now() - recordStarted) / 1000);
  const rec = mediaRecorder;
  mediaRecorder = null;
  clearTimeout(recordTimer);
  clearTimeout(recordMaxTimer);
  if (rec.state !== 'inactive') rec.stop();
  rec.onstop = async () => {
    const blob = new Blob(recordChunks, { type: kind === 'video' ? 'video/webm' : 'audio/webm' });
    recordChunks = [];
    if (recordStream) {
      recordStream.getTracks().forEach((t) => t.stop());
      recordStream = null;
    }
    removeRecorderUi();
    if (!send || duration < 1) return;
    try {
      const data = await fileToDataUrl(blob);
      const up = await api('/api/upload', { method: 'POST', body: { data } });
      if (kind === 'video') await sendMessage({ type: 'video', url: up.url, duration });
      else await sendMessage({ type: 'voice', url: up.url, duration });
    } catch (e) { showSnack(e.message); }
  };
}

function installRecorderUi(kind) {
  removeRecorderUi();
  const wrap = $('#editorWrap') || $('.editorInput.svelte-nwz8cp');
  const bar = h('<div class="recorder recorder--active svelte-uqv51g" id="recorderBar" style="margin:6px 8px;">'
    + '<div class="indicator svelte-uqv51g"><div class="dot svelte-uqv51g"></div></div>'
    + '<div class="waveform svelte-uqv51g" id="recWave" style="flex:1;height:24px;display:flex;align-items:center;"></div>'
    + '<span class="duration svelte-dvfghq note-strong weight-500 text-primary" id="recTime" style="padding:0 8px;">0:00</span>'
    + '</div>');
  const editorInput = $('.editorInput.svelte-nwz8cp');
  editorInput.style.display = 'none';
  editorInput.parentNode.insertBefore(bar, editorInput);
}

function removeRecorderUi() {
  const bar = $('#recorderBar');
  if (bar) bar.remove();
  const editorInput = $('.editorInput.svelte-nwz8cp');
  if (editorInput) editorInput.style.display = '';
}

function tickRecorder() {
  const t = $('#recTime');
  if (t) t.textContent = fmtDuration((Date.now() - recordStarted) / 1000);
  const wave = $('#recWave');
  if (wave && analyser) {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const level = Math.max(3, Math.round((sum / buf.length) / 4));
    const peak = h('<div class="peak svelte-uqv51g" style="height:' + level + 'px"></div>');
    wave.appendChild(peak);
    while (wave.children.length > 60) wave.firstChild.remove();
  }
  recordTimer = setTimeout(tickRecorder, 200);
}

async function startRecording(kind) {
  if (mediaRecorder) {
    stopRecording(true);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showSnack('Запись недоступна в этом браузере');
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia(
      kind === 'video' ? { video: { width: 480, height: 480 }, audio: true } : { audio: true });
    recordKind = kind;
    recordChunks = [];
    recordStarted = Date.now();
    mediaRecorder = new MediaRecorder(recordStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
    mediaRecorder.start();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(recordStream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
    } catch (e) { analyser = null; }
    installRecorderUi(kind);
    tickRecorder();
    if (kind === 'video') {
      recordMaxTimer = setTimeout(() => { if (mediaRecorder) stopRecording(true); }, 60000);
    }
    showSnack(kind === 'video' ? 'Идёт запись видео… Нажмите ещё раз, чтобы отправить' : 'Идёт запись… Нажмите ещё раз, чтобы отправить', 4000);
  } catch (e) {
    showSnack(kind === 'video' ? 'Нет доступа к камере' : 'Нет доступа к микрофону');
  }
}

/* ------------------------------------------------------ scroll / sticky */

function updateScrollFab() {
  const scroller = $('#historyScroll');
  const fab = $('#scrollFab');
  const counter = $('#scrollCounter');
  if (!scroller || !fab) return;
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const show = dist > 240;
  fab.style.display = show ? 'flex' : 'none';
  if (counter) {
    if (show && S.unreadBelow > 0) {
      counter.style.display = '';
      counter.textContent = S.unreadBelow > 99 ? '99+' : String(S.unreadBelow);
    } else {
      counter.style.display = 'none';
    }
  }
}

function updateStickyDate() {
  const overlay = $('#stickyDate');
  const scroller = $('#historyScroll');
  if (!overlay || !scroller) return;
  const blocks = $$('#historyContent [data-msg]');
  if (!blocks.length) { overlay.classList.remove('is-visible'); return; }
  const top = scroller.scrollTop + 60;
  let current = null;
  for (const b of blocks) {
    if (b.offsetTop <= top) current = b;
    else break;
  }
  if (!current) { overlay.classList.remove('is-visible'); return; }
  const m = S.messages.find((x) => x.id === current.dataset.msg);
  if (!m) { overlay.classList.remove('is-visible'); return; }
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (dist < 80) { overlay.classList.remove('is-visible'); return; }
  const text = fmtDaySeparator(m.ts);
  const capsule = $('.capsule', overlay);
  if (capsule.textContent !== text) capsule.textContent = text;
  overlay.classList.add('is-visible');
}

/* -------------------------------------------------------- voice playback */

function toggleVoice(btn) {
  const audio = $('#audioEl');
  const url = btn.dataset.url;
  const wave = $('.wave', btn.closest('.attachAudio'));
  if (S.playingVoice && S.playingVoice.id === btn.dataset.voice && !audio.paused) {
    audio.pause();
    btn.innerHTML = svgIcon('play_fill', 20);
    return;
  }
  if (!url) return;
  $$('.attachAudio [data-voice]').forEach((b) => { b.innerHTML = svgIcon('play_fill', 20); });
  $$('.attachAudio .peak--played').forEach((p) => p.classList.remove('peak--played'));
  audio.src = url;
  audio.play().catch(() => showSnack('Не удалось воспроизвести'));
  btn.innerHTML = svgIcon('pause_fill', 20);
  S.playingVoice = { id: btn.dataset.voice, btn, wave };
}

function bindAudioProgress() {
  const audio = $('#audioEl');
  audio.ontimeupdate = () => {
    if (!S.playingVoice || !S.playingVoice.wave) return;
    const peaks = $$('.peak', S.playingVoice.wave);
    if (!peaks.length || !audio.duration) return;
    const p = audio.currentTime / audio.duration;
    peaks.forEach((peak, i) => peak.classList.toggle('peak--played', i / peaks.length <= p));
  };
  audio.onended = () => {
    if (S.playingVoice && S.playingVoice.btn) S.playingVoice.btn.innerHTML = svgIcon('play_fill', 20);
    if (S.playingVoice && S.playingVoice.wave) $$('.peak--played', S.playingVoice.wave).forEach((p) => p.classList.remove('peak--played'));
    S.playingVoice = null;
  };
}

/* ------------------------------------------------------- chat top search */

function clearChatSearch() {
  const wrap = $('#topbarSearchWrap');
  const inp = $('#chatSearchInput');
  if (wrap) wrap.style.display = 'none';
  if (inp) inp.value = '';
  $$('#historyContent .block').forEach((b) => { b.style.display = ''; });
}

function toggleChatSearch() {
  const wrap = $('#topbarSearchWrap');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  if (open) {
    setTimeout(() => $('#chatSearchInput').focus(), 0);
  } else {
    $('#chatSearchInput').value = '';
    $$('#historyContent .block').forEach((b) => { b.style.display = ''; });
  }
}

function applyChatSearch(q) {
  q = (q || '').trim().toLowerCase();
  $$('#historyContent .block').forEach((b) => {
    const hay = b.dataset.search || '';
    b.style.display = (!q || hay.includes(q)) ? '' : 'none';
  });
}

/* ------------------------------------------------------- generic screens */

function genericHeaderHtml(title) {
  return '<div class="header svelte-1rr87da" style="display:flex;align-items:center;gap:8px;">'
    + '<button class="button button--small button--ghost svelte-1aw1384" type="button" data-back aria-label="Назад">'
    + '<div class="content svelte-1aw1384">' + svgIcon('arrow_left', 24) + '</div></button>'
    + '<h2 class="subheader svelte-dvfghq weight-600 text-primary" style="margin:0;">' + esc(title) + '</h2>'
    + '</div>';
}

function genericScrollHtml(inner) {
  return '<div class="cropped svelte-140xatc"><div class="scrollable svelte-140xatc" style="overflow:hidden auto;width:100%;height:100%;">'
    + '<div class="content svelte-140xatc" style="width:100%;height:min-content;">' + inner + '</div></div></div>';
}

function cellHtml(opts) {
  const after = opts.after !== undefined ? opts.after : svgIcon('chevron_right', 16);
  return '<div class="cell cell--action cellBorderRadius-m svelte-143i7y" role="button" data-act="' + esc(opts.act || '') + '">'
    + (opts.before ? '<div class="before svelte-143i7y">' + opts.before + '</div>' : '')
    + '<div class="content svelte-143i7y">'
    + '<span class="body svelte-dvfghq weight-400 ' + (opts.danger ? 'text-negative' : 'text-primary') + '">' + esc(opts.label) + '</span>'
    + (opts.details ? '<span class="description svelte-dvfghq weight-400 text-tertiary" data-type="description">' + esc(opts.details) + '</span>' : '')
    + '</div>'
    + (after !== null ? '<div class="after svelte-143i7y">' + after + '</div>' : '')
    + '<button class="overlay svelte-143i7y" tabindex="-1" type="button"></button></div>';
}

function buildGeneric(kind) {
  const box = $('#screenGeneric');
  if (kind === 'settings') return buildSettings(box);
  if (kind === 'profile-peer') return buildPeerProfile(box);
  if (kind === 'profile-me') return buildMyProfile(box);
  if (kind === 'contacts') return buildContacts(box);
  if (kind === 'calls') return buildCalls(box);
  if (kind === 'theme') return buildTheme(box);
  box.innerHTML = '';
}

function bindGenericBack(box) {
  const back = $('[data-back]', box);
  if (back) {
    back.onclick = () => {
      if (S.prevKind) {
        const kind = S.prevKind;
        S.prevKind = null;
        showScreen('generic', kind, true);
        return;
      }
      const target = (S.prevScreen === 'chat' && S.activeChatId) ? 'chat' : 'placeholder';
      showScreen(target);
      if (target === 'chat') enterMain();
      else leaveMain();
    };
  }
}

function buildSettings(box) {
  const me = S.me;
  box.innerHTML = genericHeaderHtml('Настройки')
    + genericScrollHtml(
      '<div class="list svelte-11yj69v"><div class="island svelte-11yj69v">'
      + '<div class="cell cell--action cellBorderRadius-m svelte-143i7y" role="button" data-act="my-profile">'
      + '<div class="before svelte-143i7y">' + avatarHtml(me, 40) + '</div>'
      + '<div class="content svelte-143i7y">'
      + '<span class="body-strong svelte-dvfghq weight-500 text-primary">' + esc(me.name || me.number) + '</span>'
      + '<span class="description svelte-dvfghq weight-400 text-tertiary">+' + esc(me.number) + '</span>'
      + '</div><div class="after svelte-143i7y">' + svgIcon('chevron_right', 16) + '</div>'
      + '<button class="overlay svelte-143i7y" tabindex="-1" type="button"></button></div>'
      + '</div></div>'

      + '<div class="list svelte-11yj69v"><div class="island svelte-11yj69v">'
      + cellHtml({ act: 'edit-name', label: 'Изменить имя', before: svgIcon('edit', 24) })
      + cellHtml({ act: 'edit-avatar', label: 'Сменить аватар', before: svgIcon('camera_fill', 24) })
      + cellHtml({ act: 'edit-password', label: 'Сменить пароль', before: svgIcon('password', 24) })
      + cellHtml({ act: 'theme', label: 'Оформление', before: svgIcon('grid', 24) })
      + '</div></div>'

      + '<div class="list svelte-11yj69v"><div class="island svelte-11yj69v">'
      + cellHtml({ act: 'logout', label: 'Выйти', danger: true, after: null, before: '<span class="cellDeleteIcon svelte-1lebyxc">' + svgIcon('autorization_leave', 24) + '</span>' })
      + '</div></div>'
    );
  bindGenericBack(box);
  $$('[data-act]', box).forEach((cell) => {
    cell.onclick = () => {
      const act = cell.dataset.act;
      if (act === 'my-profile') showScreen('generic', 'profile-me');
      else if (act === 'edit-name') dialogEditName();
      else if (act === 'edit-avatar') dialogEditAvatar();
      else if (act === 'edit-password') dialogChangePassword();
      else if (act === 'theme') showScreen('generic', 'theme');
      else if (act === 'logout') confirmDialog('Выйти из аккаунта?', 'Потом можно войти снова с этим номером.', 'Выйти', true, logout);
    };
  });
}

function dialogEditName() {
  const el = openDialog(
    '<div style="padding:24px 16px 8px;display:flex;flex-direction:column;gap:12px;">'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">Изменить имя</div>'
    + '<div class="input input--secondary svelte-dp7rey"><input class="field svelte-dp7rey" id="nameInput" maxlength="64" placeholder="Имя"></div>'
    + '</div>'
    + '<div class="buttonStack svelte-46f2bg" style="padding-bottom:16px;">'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--secondary svelte-1aw1384" data-cancel type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Отмена</span></div></button></div>'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--primary svelte-1aw1384" data-ok type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Сохранить</span></div></button></div>'
    + '</div>'
  );
  const inp = $('#nameInput', el);
  inp.value = S.me.name || '';
  $('[data-cancel]', el).onclick = closeDialog;
  $('[data-ok]', el).onclick = async () => {
    const name = inp.value.trim();
    if (!name) return;
    try {
      const r = await api('/api/me', { method: 'POST', body: { name } });
      S.me = r.user;
      closeDialog();
      showSnack('Имя обновлено');
      renderGenericIfVisible();
      updateTopbarForChat();
      renderChatList();
    } catch (e) { showSnack(e.message); }
  };
  setTimeout(() => inp.focus(), 0);
}

const AVATAR_CHOICES = [null, '/img/i.jpg', '/img/i(5).jpg', '/img/getImage.jpg', '/img/getImage(1).jpg'];

function dialogEditAvatar() {
  const cells = AVATAR_CHOICES.map((url, i) => {
    const selected = (S.me.avatar || null) === url;
    const u = { avatar: url, name: S.me.name };
    return '<button class="avatar-cell svelte-vywflk' + (selected ? ' avatar-cell--selected' : '') + '" data-i="' + i
      + '" type="button" style="background:none;">'
      + (url ? '<img src="' + esc(url) + '" alt="" style="border-radius:50%;width:60px;height:60px;object-fit:cover;">'
        : '<span style="width:60px;height:60px;border-radius:50%;background:var(--background-tertiary);color:var(--text-tertiary);display:inline-flex;align-items:center;justify-content:center;font:600 24px/1 var(--font);">'
        + esc(((S.me.name || '?').charAt(0) || '?').toUpperCase()) + '</span>')
      + '</button>';
  }).join('');
  const el = openDialog(
    '<div style="padding:24px 16px 8px;display:flex;flex-direction:column;gap:16px;">'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">Сменить аватар</div>'
    + '<div class="avatar-list svelte-vywflk" style="justify-content:center;">' + cells + '</div></div>'
    + '<div class="buttonStack svelte-46f2bg" style="padding-bottom:16px;">'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--secondary svelte-1aw1384" data-cancel type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Закрыть</span></div></button></div>'
    + '</div>'
  );
  $('[data-cancel]', el).onclick = closeDialog;
  $$('.avatar-cell', el).forEach((b) => {
    b.onclick = async () => {
      const url = AVATAR_CHOICES[+b.dataset.i];
      try {
        const r = await api('/api/me', { method: 'POST', body: { avatar: url } });
        S.me = r.user;
        $$('.avatar-cell', el).forEach((x) => x.classList.remove('avatar-cell--selected'));
        b.classList.add('avatar-cell--selected');
        renderGenericIfVisible();
        renderChatList();
        showSnack('Аватар обновлён');
      } catch (e) { showSnack(e.message); }
    };
  });
}

function dialogChangePassword() {
  const el = openDialog(
    '<div style="padding:24px 16px 8px;display:flex;flex-direction:column;gap:12px;">'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">Сменить пароль</div>'
    + '<div class="input input--secondary svelte-dp7rey"><input class="field svelte-dp7rey" id="oldPass" type="password" placeholder="Текущий пароль"></div>'
    + '<div class="input input--secondary svelte-dp7rey"><input class="field svelte-dp7rey" id="newPass" type="password" placeholder="Новый пароль"></div>'
    + '<div id="cpError" class="description svelte-dvfghq weight-400 text-negative" style="display:none;"></div>'
    + '</div>'
    + '<div class="buttonStack svelte-46f2bg" style="padding-bottom:16px;">'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--secondary svelte-1aw1384" data-cancel type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Отмена</span></div></button></div>'
    + '<div class="buttonStackItem svelte-1g60xs4"><button class="button button--medium button--primary svelte-1aw1384" data-ok type="button"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Сохранить</span></div></button></div>'
    + '</div>'
  );
  $('[data-cancel]', el).onclick = closeDialog;
  $('[data-ok]', el).onclick = async () => {
    const oldPassword = $('#oldPass', el).value;
    const newPassword = $('#newPass', el).value;
    try {
      await api('/api/change-password', { method: 'POST', body: { oldPassword, newPassword } });
      closeDialog();
      showSnack('Пароль изменён');
    } catch (e) {
      const err = $('#cpError', el);
      err.textContent = e.message;
      err.style.display = '';
    }
  };
}

const THEMES = ['space', 'feb23', 'mar8', 'nature', 'neon', 'moscow', 'lebedev', 'simple', 'aquamarine', 'tadam'];
const THEME_LABELS = {
  space: 'Космос', feb23: '23 февраля', mar8: '8 марта', nature: 'Природа', neon: 'Неон',
  moscow: 'Москва', lebedev: 'Лебедев', simple: 'Простая', aquamarine: 'Аквамарин', tadam: 'Тадам',
};

function buildTheme(box) {
  const scheme = document.documentElement.dataset.colorScheme || 'light';
  const theme = document.documentElement.dataset.colorTheme || 'space';
  box.innerHTML = genericHeaderHtml('Оформление')
    + genericScrollHtml(
      '<div class="list svelte-11yj69v"><div class="island svelte-11yj69v">'
      + cellHtml({ act: 'scheme-light', label: 'Светлая тема', before: svgIcon('grid', 24), after: scheme === 'light' ? svgIcon('check_round', 20) : '' })
      + cellHtml({ act: 'scheme-dark', label: 'Тёмная тема', before: svgIcon('grid', 24), after: scheme === 'dark' ? svgIcon('check_round', 20) : '' })
      + '</div></div>'
      + '<div class="list svelte-11yj69v"><div class="island svelte-11yj69v">'
      + THEMES.map((t) => cellHtml({
        act: 'theme-' + t,
        label: THEME_LABELS[t] || t,
        before: svgIcon('palette' in {} ? 'grid' : 'grid', 24),
        after: theme === t ? svgIcon('check_round', 20) : '',
      })).join('')
      + '</div></div>'
    );
  bindGenericBack(box);
  $$('[data-act]', box).forEach((cell) => {
    cell.onclick = () => {
      const act = cell.dataset.act;
      if (act === 'scheme-light' || act === 'scheme-dark') {
        document.documentElement.dataset.colorScheme = act === 'scheme-light' ? 'light' : 'dark';
        localStorage.setItem('max_scheme', document.documentElement.dataset.colorScheme);
      } else if (act.startsWith('theme-')) {
        document.documentElement.dataset.colorTheme = act.slice(6);
        localStorage.setItem('max_theme', document.documentElement.dataset.colorTheme);
      }
      buildTheme(box);
    };
  });
}

function buildPeerProfile(box) {
  const chat = activeChat();
  if (!chat) { box.innerHTML = ''; return; }
  const p = peerOf(chat);
  const online = peerOnline(chat);
  box.innerHTML = genericHeaderHtml('Профиль')
    + genericScrollHtml(
      '<div class="list svelte-11yj69v"><div class="wrapper svelte-177pqrz" style="margin:0 auto;padding-top:8px;">'
      + '<div class="header svelte-177pqrz">'
      + '<div class="avatarButton svelte-177pqrz"><div class="avatar svelte-1gp4c0a" style="--avatarSize:120px;">'
      + avatarHtml(p, 120) + '</div></div>'
      + '<div class="titleWrapper svelte-177pqrz"><div class="title svelte-177pqrz">' + esc(p.name || p.number) + '</div>'
      + '<div class="subtitle svelte-177pqrz">' + esc(online ? 'в сети' : 'не в сети') + ' · +' + esc(p.number) + '</div></div>'
      + '</div>'
      + '<div class="panel svelte-1lebyxc">'
      + '<div class="buttons svelte-1lebyxc">'
      + '<button class="button button--medium button--primary svelte-1aw1384" data-act="write" type="button" style="flex:1"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Написать</span></div></button>'
      + '<button class="button button--medium button--secondary svelte-1aw1384" data-act="call" type="button" style="flex:1"><div class="content svelte-1aw1384">' + svgIcon('call', 20) + '<span class="title action-medium svelte-dvfghq weight-500" style="margin-left:6px">Позвонить</span></div></button>'
      + '<button class="button button--medium button--secondary svelte-1aw1384" data-act="videocall" type="button" style="flex:1"><div class="content svelte-1aw1384">' + svgIcon('video_call', 20) + '<span class="title action-medium svelte-dvfghq weight-500" style="margin-left:6px">Видео</span></div></button>'
      + '</div></div>'
      + '</div></div>'
    );
  bindGenericBack(box);
  $('[data-act=write]', box).onclick = () => { showScreen('chat'); enterMain(); };
  $('[data-act=call]', box).onclick = () => startCall(false);
  $('[data-act=videocall]', box).onclick = () => startCall(true);
}

function buildMyProfile(box) {
  const me = S.me;
  box.innerHTML = genericHeaderHtml('Профиль')
    + genericScrollHtml(
      '<div class="list svelte-11yj69v"><div class="wrapper svelte-177pqrz" style="margin:0 auto;padding-top:8px;">'
      + '<div class="header svelte-177pqrz">'
      + '<div class="avatarButton svelte-177pqrz"><div class="avatar svelte-1gp4c0a" style="--avatarSize:120px;">'
      + avatarHtml(me, 120) + '</div></div>'
      + '<div class="titleWrapper svelte-177pqrz"><div class="title svelte-177pqrz">' + esc(me.name || me.number) + '</div>'
      + '<div class="subtitle svelte-177pqrz">+' + esc(me.number) + '</div></div>'
      + '</div>'
      + '<div class="panel svelte-1lebyxc"><div class="buttons svelte-1lebyxc">'
      + '<button class="button button--medium button--primary svelte-1aw1384" data-act="edit-name" type="button" style="flex:1"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Изменить имя</span></div></button>'
      + '<button class="button button--medium button--secondary svelte-1aw1384" data-act="edit-avatar" type="button" style="flex:1"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500">Аватар</span></div></button>'
      + '</div></div>'
      + '</div></div>'
    );
  bindGenericBack(box);
  $('[data-act=edit-name]', box).onclick = dialogEditName;
  $('[data-act=edit-avatar]', box).onclick = dialogEditAvatar;
}

async function buildContacts(box) {
  box.innerHTML = genericHeaderHtml('Контакты')
    + genericScrollHtml('<div class="emptyList svelte-1gs5umf" id="contactsList">Загрузка…</div>');
  bindGenericBack(box);
  try {
    const r = await api('/api/search-users?q=');
    const list = $('#contactsList', box);
    if (!list) return;
    if (!r.users.length) {
      list.textContent = 'Контактов пока нет';
      return;
    }
    list.className = '';
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 16px 24px;';
    list.innerHTML = r.users.map(userRowHtml).join('');
    $$('[data-user]', list).forEach((cell) => {
      cell.onclick = () => startChatWith(cell.dataset.user);
    });
  } catch (e) {
    const list = $('#contactsList', box);
    if (list) list.textContent = e.message;
  }
}

function callRowHtml(c) {
  const me = S.me.number;
  const out = c.from === me;
  const peer = c.peer || { number: '', name: '?' };
  let icon, status;
  const video = c.video;
  if (c.status === 'missed' || c.status === 'rejected' || c.status === 'cancelled') {
    icon = video ? 'video_call_missed_fill' : 'call_missed_fill';
    status = c.status === 'missed' ? 'Пропущенный' : c.status === 'rejected' ? 'Отклонённый' : 'Отменённый';
  } else {
    icon = out
      ? (video ? 'video_call_outgoing_fill' : 'call_outgoing_fill')
      : (video ? 'video_call_incoming_fill' : 'call_incoming_fill');
    status = out ? 'Исходящий' : 'Входящий';
  }
  const dur = c.duration ? ' · ' + fmtDuration(c.duration) : '';
  return '<div class="cell cell--action cellBorderRadius-m svelte-143i7y" role="button" data-call="' + esc(peer.number) + '">'
    + '<div class="before svelte-143i7y">' + avatarHtml(peer, 40) + '</div>'
    + '<div class="content svelte-143i7y">'
    + '<span class="body svelte-dvfghq weight-400 text-primary">' + esc(peer.name || peer.number) + '</span>'
    + '<span class="description svelte-dvfghq weight-400 ' + (c.status === 'missed' ? 'text-negative' : 'text-tertiary') + '">'
    + svgIcon(icon, 14) + ' ' + status + dur + '</span>'
    + '</div>'
    + '<div class="after svelte-143i7y"><span class="description svelte-dvfghq weight-400 text-tertiary">'
    + esc(fmtListTime(c.ts)) + '</span></div>'
    + '<button class="overlay svelte-143i7y" tabindex="-1" type="button"></button></div>';
}

async function buildCalls(box) {
  box.innerHTML = genericHeaderHtml('Звонки')
    + genericScrollHtml('<div class="emptyList svelte-1gs5umf" id="callsList">Загрузка…</div>');
  bindGenericBack(box);
  try {
    const r = await api('/api/calls');
    const list = $('#callsList', box);
    if (!list) return;
    if (!r.calls.length) {
      list.textContent = 'Звонков пока нет';
      return;
    }
    list.className = '';
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 16px 24px;';
    list.innerHTML = r.calls.map(callRowHtml).join('');
    $$('[data-call]', list).forEach((cell) => {
      cell.onclick = async () => {
        const number = cell.dataset.call;
        if (!number) return;
        try {
          const cr = await api('/api/calls', { method: 'POST', body: { to: number, video: false } });
          if (cr.call.status === 'missed') showSnack('Абонент недоступен');
          else {
            S.call = { data: cr.call, direction: 'out', state: 'ringing' };
            renderCall();
          }
        } catch (e) { showSnack(e.message); }
      };
    });
  } catch (e) {
    const list = $('#callsList', box);
    if (list) list.textContent = e.message;
  }
}

/* -------------------------------------------------------------- calls UI */

function renderCall() {
  const layer = $('#callsLayer');
  clearInterval(S.callTimer);
  S.callTimer = null;
  if (!S.call) { layer.innerHTML = ''; return; }
  const { data: call, direction, state } = S.call;
  const me = S.me.number;
  const peerNum = call.from === me ? call.to : call.from;
  const chat = S.chats.find((c) => c.peer && c.peer.number === peerNum);
  const peer = chat ? peerOf(chat) : { number: peerNum, name: peerNum };
  const incoming = direction === 'in';
  const ringing = state === 'ringing';
  const statusText = ringing
    ? (incoming ? 'Входящий вызов…' : 'Вызов…')
    : (call.video ? 'Видеозвонок' : 'Звонок');

  let buttons;
  if (ringing && incoming) {
    buttons =
      '<button class="button button--medium button--primary svelte-1aw1384" data-call-act="accept" type="button">'
      + '<div class="content svelte-1aw1384">' + svgIcon('call_fill', 20) + '</div></button>'
      + '<button class="button button--medium button--destructive svelte-1aw1384" data-call-act="decline" type="button">'
      + '<div class="content svelte-1aw1384">' + svgIcon('call_missed_fill', 20) + '</div></button>';
  } else {
    buttons =
      '<button class="button button--medium button--destructive svelte-1aw1384" data-call-act="hangup" type="button">'
      + '<div class="content svelte-1aw1384">' + svgIcon('call_missed_fill', 20) + '</div></button>';
  }

  layer.innerHTML =
    '<div class="container svelte-hxq3il" style="position:relative;">'
    + '<div class="call svelte-hxq3il">'
    + '<div class="main svelte-hxq3il">'
    + '<div class="avatar svelte-1gp4c0a" style="--avatarSize:64px;">' + avatarHtml(peer, 64) + '</div>'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">' + esc(peer.name || peer.number) + '</div>'
    + '<div class="description svelte-dvfghq weight-400 text-secondary" id="callStatus">' + statusText + '</div>'
    + '</div>'
    + '<div class="buttons svelte-hxq3il' + (ringing && incoming ? '' : ' buttons--hangup') + '" style="opacity:1;">'
    + buttons + '</div>'
    + '</div></div>';

  $$('[data-call-act]', layer).forEach((b) => {
    b.onclick = () => onCallButton(b.dataset.callAct);
  });

  if (state === 'active') {
    const start = call.startedAt || Date.now();
    const tick = () => {
      const el = $('#callStatus');
      if (el) el.textContent = fmtDuration((Date.now() - start) / 1000);
    };
    tick();
    S.callTimer = setInterval(tick, 1000);
  }
}

async function startCall(video) {
  const chat = activeChat();
  if (!chat) return;
  const p = peerOf(chat);
  try {
    const r = await api('/api/calls', { method: 'POST', body: { to: p.number, video: !!video } });
    if (r.call.status === 'missed') {
      showSnack('Абонент недоступен');
      return;
    }
    S.call = { data: r.call, direction: 'out', state: 'ringing' };
    renderCall();
  } catch (e) { showSnack(e.message); }
}

async function onCallButton(act) {
  if (!S.call) return;
  const id = S.call.data.id;
  try {
    if (act === 'accept') {
      const r = await api('/api/calls/' + id + '/accept', { method: 'POST' });
      S.call = { data: r.call, direction: 'in', state: 'active' };
      renderCall();
    } else if (act === 'decline') {
      await api('/api/calls/' + id + '/decline', { method: 'POST' });
      S.call = null;
      renderCall();
    } else if (act === 'hangup') {
      await api('/api/calls/' + id + '/hangup', { method: 'POST' });
      S.call = null;
      renderCall();
    }
  } catch (e) { showSnack(e.message); }
}

function onCallIncoming(call) {
  if (S.call && S.call.data.id === call.id) return;
  S.call = { data: call, direction: 'in', state: 'ringing' };
  renderCall();
  $('#liveRegion').textContent = 'Входящий вызов';
}

function onCallAccepted(call) {
  if (!S.call || S.call.data.id !== call.id) {
    S.call = { data: call, direction: call.from === (S.me && S.me.number) ? 'out' : 'in', state: 'active' };
  } else {
    S.call.state = 'active';
    S.call.data = call;
  }
  renderCall();
}

function onCallEnded(call) {
  if (!S.call || S.call.data.id !== (call && call.id)) {
    if (call && call.status === 'missed' && call.to === (S.me && S.me.number)) {
      showSnack('Пропущенный вызов');
    }
    return;
  }
  const status = call.status;
  const el = $('#callStatus');
  const text = status === 'missed' ? 'Абонент недоступен'
    : status === 'rejected' ? 'Вызов отклонён'
      : status === 'cancelled' ? 'Вызов отменён'
        : 'Звонок завершён' + (call.duration ? ' · ' + fmtDuration(call.duration) : '');
  if (el) el.textContent = text;
  const buttons = $('#callsLayer .buttons');
  if (buttons) buttons.style.display = 'none';
  setTimeout(() => {
    S.call = null;
    renderCall();
  }, 1800);
}

/* ---------------------------------------------------------- aside search */

const runAsideSearch = debounce(async () => {
  const q = ($('#asideSearchInput').value || '').trim();
  if (q.length >= 2) {
    try {
      const r = await api('/api/search-users?q=' + encodeURIComponent(q));
      S.searchUsers = r.users;
    } catch (e) { S.searchUsers = null; }
  } else {
    S.searchUsers = null;
  }
  renderChatList();
}, 250);

function openNewChatDialog() {
  const el = openDialog(
    '<div style="padding:16px 16px 8px;display:flex;flex-direction:column;gap:12px;">'
    + '<div class="subheader svelte-dvfghq weight-600 text-primary">Новое сообщение</div>'
    + '<div class="input input--secondary svelte-dp7rey">'
    + '<span class="icon icon--left svelte-dp7rey">' + svgIcon('search', 20) + '</span>'
    + '<input class="field svelte-dp7rey" id="ncSearch" type="text" placeholder="Поиск людей"></div>'
    + '</div>'
    + '<div id="ncList" style="padding:4px 16px 16px;display:flex;flex-direction:column;gap:4px;max-height:50vh;overflow:auto;"></div>'
  );
  const list = $('#ncList', el);
  const render = (users) => {
    list.innerHTML = users.length
      ? users.map(userRowHtml).join('')
      : '<div class="emptyList svelte-1gs5umf">Никого не нашли</div>';
    $$('[data-user]', list).forEach((cell) => {
      cell.onclick = () => startChatWith(cell.dataset.user);
    });
  };
  render([]);
  api('/api/search-users?q=').then((r) => render(r.users)).catch(() => {});
  $('#ncSearch', el).addEventListener('input', debounce(async () => {
    const q = $('#ncSearch', el).value.trim();
    try {
      const r = await api('/api/search-users?q=' + encodeURIComponent(q));
      render(r.users);
    } catch (e) { /* noop */ }
  }, 250));
  setTimeout(() => $('#ncSearch', el).focus(), 0);
}

/* ------------------------------------------------------------- bindings */

function bindShell() {
  // folders
  $$('[data-folder]').forEach((b) => {
    b.onclick = () => {
      S.folder = b.dataset.folder;
      $$('[data-folder]').forEach((x) => x.classList.toggle('button--active', x === b));
      renderChatList();
      if (isMobile() && S.screen !== 'placeholder') {
        // stay in current screen; list just re-filters
      }
    };
  });
  // nav bottom group
  $$('[data-nav]').forEach((b) => {
    b.onclick = () => {
      S.prevScreen = S.screen;
      showScreen('generic', b.dataset.nav);
      enterMain();
    };
  });
  // aside search
  $('#asideSearchInput').addEventListener('input', runAsideSearch);
  $('#newChatBtn').onclick = openNewChatDialog;
  $('#placeholderNewChat').onclick = openNewChatDialog;

  // topbar
  $('#backBtn').onclick = goBackFromChat;
  $('#topbarMainBtn').onclick = () => {
    if (!activeChat()) return;
    S.prevScreen = 'chat';
    showScreen('generic', 'profile-peer');
    enterMain();
  };
  $('#callBtn').onclick = () => startCall(false);
  $('#videoCallBtn').onclick = () => startCall(true);
  $('#chatSearchBtn').onclick = toggleChatSearch;
  $('#chatSearchInput').addEventListener('input', (e) => applyChatSearch(e.target.value));

  // composer
  const editor = $('#editor');
  editor.addEventListener('input', () => {
    updatePlaceholder();
    sendTyping();
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  $('#attachBtn').onclick = () => $('#attachInput').click();
  $('#attachInput').addEventListener('change', (e) => {
    sendFiles(e.target.files);
    e.target.value = '';
  });
  $('#stickerBtn').onclick = toggleStickerPanel;
  $('#videoMsgBtn').onclick = () => startRecording('video');
  $('#voiceBtn').onclick = () => startRecording('audio');
  $('#scrollFab').onclick = () => {
    scrollToBottom(true);
    S.unreadBelow = 0;
    updateScrollFab();
  };

  // history scroll
  const scroller = $('#historyScroll');
  scroller.addEventListener('scroll', () => {
    updateScrollFab();
    updateStickyDate();
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (dist < 40 && S.unreadBelow) {
      S.unreadBelow = 0;
      updateScrollFab();
    }
  });

  // drag & drop
  const historyRoot = $('#historyRoot');
  let dragDepth = 0;
  historyRoot.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('#dropArea').classList.add('droparea--active');
  });
  historyRoot.addEventListener('dragover', (e) => e.preventDefault());
  historyRoot.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropArea').classList.remove('droparea--active');
  });
  historyRoot.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropArea').classList.remove('droparea--active');
    if (e.dataTransfer && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
  });

  // global keys
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      const panel = $('#stickerPanel');
      if (panel) panel.remove();
      if (S.screen === 'generic') {
        // dialog handles itself; generic back
      }
    }
  });

  // dialog backdrop
  $('#dialog').addEventListener('close', () => { $('#dialogContent').innerHTML = ''; });

  bindAudioProgress();

  // responsive
  window.addEventListener('resize', debounce(() => {
    ensureTabbar();
    if (!isMobile()) {
      // desktop: main always visible; keep classes harmless
    } else if (S.screen === 'chat' || S.screen === 'generic') {
      enterMain();
    } else {
      leaveMain();
    }
    updateTabbarActive();
  }, 150));
}

/* ------------------------------------------------------------------ boot */

async function loadApp() {
  try {
    const r = await api('/api/chats');
    S.chats = r.chats || [];
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    showSnack(e.message);
  }
  ensureTabbar();
  showScreen('placeholder');
  leaveMain();
  renderChatList();
  updateNavCounters();
  connectSSE();
  hideBoot();
}

async function boot() {
  // theme
  const savedScheme = localStorage.getItem('max_scheme');
  const savedTheme = localStorage.getItem('max_theme');
  if (savedScheme) document.documentElement.dataset.colorScheme = savedScheme;
  if (savedTheme) document.documentElement.dataset.colorTheme = savedTheme;

  bindShell();

  if (!S.token) {
    hideBoot();
    showAuth();
    return;
  }
  try {
    const r = await api('/api/me');
    S.me = r.user;
    $('#authRoot').style.display = 'none';
    $('#appRoot').style.display = 'grid';
    await loadApp();
  } catch (e) {
    S.token = null;
    localStorage.removeItem('max_token');
    hideBoot();
    showAuth();
  }
}

boot();
