import { makeZip, makePdf, readZip } from './lib.js';

// ---------- utilitários ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const localMonth = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const localStamp = (d) => `${localMonth(d)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
const fmtDateTime = (iso) => new Date(iso).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtSize = (b) => (b < 1e6 ? `${b ? Math.max(1, Math.round(b / 1e3)) : 0} KB` : `${(b / 1e6).toFixed(1).replace('.', ',')} MB`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const collator = new Intl.Collator('pt', { sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().replace(/^\.+/, '').trim() || 'Sem nome';
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const kindOf = (n) => (n.ext === 'jpg' ? 'Foto' : Number(n.pageCount) > 1 ? `PDF, ${Number(n.pageCount)} páginas` : 'PDF');
const MAIL_LIMIT = 20e6; // limite prudente para anexos de e-mail
const APP_VERSION = '18'; // igual ao número em CACHE no sw.js

// ---------- componentes Carbon (HTML) ----------
function textField(id, label, value = '', { hint = '', placeholder = '', autocomplete = 'off' } = {}) {
  return `<div class="cds--form-item cds--text-input-wrapper">
    <label for="${id}" class="cds--label">${esc(label)}</label>
    <div class="cds--text-input__field-outer-wrapper"><div class="cds--text-input__field-wrapper">
      <input id="${id}" class="cds--text-input cds--text-input--lg cds--layout--size-lg" type="text" maxlength="60" autocomplete="${autocomplete}" value="${esc(value)}" placeholder="${esc(placeholder)}">
    </div></div>
    ${hint ? `<div class="cds--form__helper-text">${esc(hint)}</div>` : ''}
  </div>`;
}
function selectField(id, label, options) {
  return `<div class="cds--form-item"><div class="cds--select">
    <label for="${id}" class="cds--label">${esc(label)}</label>
    <div class="cds--select-input__wrapper">
      <select id="${id}" class="cds--select-input cds--select-input--lg cds--layout--size-lg">${options}</select>
      ${icon('chevron-down', 'cds--select__arrow')}
    </div>
  </div></div>`;
}
function notification(kind, title, subtitle, actionHtml = '') {
  return `<div class="cds--inline-notification cds--inline-notification--${kind} cds--inline-notification--low-contrast" role="status">
    <div class="cds--inline-notification__details">
      ${icon(kind === 'warning' ? 'warning' : 'information', 'cds--inline-notification__icon')}
      <div class="cds--inline-notification__text-wrapper">
        <div class="cds--inline-notification__title">${title}</div>
        <div class="cds--inline-notification__subtitle">${subtitle}${actionHtml}</div>
      </div>
    </div>
  </div>`;
}

// ---------- base de dados (IndexedDB, só neste aparelho) ----------
let db;
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('recibos', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('settings');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const os = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
function write(name, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(name, 'readwrite');
    fn(t.objectStore(name));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const putOne = (name, val, key) => write(name, (s) => (key === undefined ? s.put(val) : s.put(val, key)));
const delOne = (name, key) => write(name, (s) => s.delete(key));

// ---------- estado ----------
const state = { settings: { person: '', org: '', lastProject: null }, projects: [], notes: [], view: 'pending' };
const projectName = (id) => state.projects.find((p) => p.id === id)?.name || 'Sem projeto';
const pendingNotes = () => state.notes.filter((n) => !n.sentAt);
const saveSettings = () => putOne('settings', state.settings, 'main');

async function load() {
  const [s, projects, notes] = await Promise.all([req(os('settings').get('main')), req(os('projects').getAll()), req(os('notes').getAll())]);
  state.settings = { ...state.settings, ...(s || {}) };
  state.projects = projects.sort(byName);
  state.notes = notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Miniaturas: uma URL por recibo, libertada quando o recibo é apagado.
const thumbUrls = new Map();
function thumbUrl(note) {
  if (!note.thumb) return null;
  if (!thumbUrls.has(note.id)) thumbUrls.set(note.id, URL.createObjectURL(note.thumb));
  return thumbUrls.get(note.id);
}
function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(id);
}

// ---------- navegação e mensagens ----------
function go(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('is-active', p.id === id));
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === id;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
  render();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-go]');
  if (t) go(t.dataset.tab || t.dataset.go);
});

// Confirmações só visuais: visto rápido (como o iOS) e celebração no fecho do mês.
const CHECK_SVG = '<svg class="fx-check" viewBox="0 0 48 48" aria-hidden="true"><path d="M10 25l9 9 19-20"/></svg>';
let fxTimer;
function playFx(kind, ms) {
  const el = $('fx');
  clearTimeout(fxTimer);
  el.className = 'fx';
  el.innerHTML = `<div class="fx-box">${CHECK_SVG}</div>`;
  void el.offsetWidth;
  el.classList.add(`fx--${kind}`, 'go');
  fxTimer = setTimeout(() => { el.className = 'fx'; el.innerHTML = ''; }, ms);
  return el;
}
function check() { playFx('hud', 1300); }
function celebrate() {
  const el = playFx('party', 2400);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !el.animate) return;
  for (let i = 0; i < 32; i++) {
    const b = document.createElement('span');
    b.className = `fx-bit${i % 3 === 1 ? ' fx-bit--gray' : i % 3 === 2 ? ' fx-bit--line' : ''}`;
    const ang = (i / 32) * Math.PI * 2 + Math.random() * 0.3;
    const dist = 110 + Math.random() * 90;
    const size = 8 + Math.random() * 10;
    b.style.width = b.style.height = `${size}px`;
    el.append(b);
    b.animate([
      { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist + 50}px)) rotate(${Math.random() * 360}deg)`, opacity: 0 },
    ], { duration: 1300 + Math.random() * 500, delay: 250, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
  }
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- janela (Carbon modal) ----------
let onModalClose = null;
let busy = false; // enquanto processa fotos ou guarda, a janela não fecha
const modalOpen = () => $('modal').classList.contains('is-visible');

// Com a janela aberta, o leitor de ecrã e o teclado não chegam ao que está por trás.
function setBackgroundInert(on) {
  document.querySelectorAll('.app-main, .tabbar').forEach((el) => { el.inert = on; });
}

// spec: { title, label?, body, actions: [{ id, label, kind }], closable? }
function setModal(spec) {
  const actions = spec.actions || [];
  $('modal-container').innerHTML = `
    <div class="cds--modal-header">
      ${spec.label ? `<p class="cds--modal-header__label">${esc(spec.label)}</p>` : ''}
      <h2 class="cds--modal-header__heading" id="modal-title" tabindex="-1">${esc(spec.title)}</h2>
      ${spec.closable === false ? '' : `<div class="cds--modal-close-button"><button class="cds--modal-close" type="button" data-modal-close aria-label="Fechar">${icon('close', 'cds--modal-close__icon')}</button></div>`}
    </div>
    <div class="cds--modal-content">${spec.body || ''}</div>
    ${actions.length ? `<div class="cds--modal-footer cds--btn-set">${actions.map((a) => `<button type="button" class="cds--btn cds--btn--${a.kind || 'primary'}" id="${a.id}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</div>` : ''}`;
}
function openModal(spec, onClose) {
  setModal(spec);
  onModalClose = onClose || null;
  $('modal').classList.add('is-visible');
  document.body.classList.add('cds--body--with-modal-open');
  setBackgroundInert(true);
  $('modal-title')?.focus?.();
}
function closeModal() {
  $('modal').classList.remove('is-visible');
  document.body.classList.remove('cds--body--with-modal-open');
  setBackgroundInert(false);
  $('modal-container').innerHTML = '';
  const fn = onModalClose;
  onModalClose = null;
  if (fn) fn();
}
$('modal').addEventListener('click', (e) => {
  if (busy) return;
  if (e.target === $('modal') || e.target.closest('[data-modal-close]')) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen() && !busy) closeModal(); });

// ---------- imagens ----------
function decodeImage(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagem ilegível')); };
    img.src = u;
  });
}
// Reduz a foto (o <img> respeita a orientação da câmara) e converte para JPEG.
async function toJpeg(blob, max = 2000, quality = 0.82) {
  const img = await decodeImage(blob);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const width = Math.round(w0 * scale), height = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const out = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('falha a converter'))), 'image/jpeg', quality));
  return { blob: out, width, height };
}

// ---------- novo recibo ----------
let draft = null; // { pages: [{blob,width,height,url}], pdf: Blob|null, pdfName, projectId, newName }
const newDraft = () => ({ pages: [], pdf: null, pdfName: '', projectId: defaultProject(), newName: '' });
function defaultProject() {
  if (state.projects.some((p) => p.id === state.settings.lastProject)) return state.settings.lastProject;
  return state.projects[0]?.id || '__new';
}
function discardDraft() {
  if (draft) draft.pages.forEach((p) => URL.revokeObjectURL(p.url));
  draft = null;
}

$('photo-action').onclick = () => { if (!draft) draft = newDraft(); $('photo-input').click(); };
$('file-action').onclick = () => { if (!draft) draft = newDraft(); $('file-input').click(); };
$('photo-input').onchange = (e) => handleFiles(e.target);
$('file-input').onchange = (e) => handleFiles(e.target);

async function handleFiles(input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) { if (!modalOpen()) discardDraft(); return; }
  if (!draft) draft = newDraft();
  const pdfs = files.filter(isPdf);
  const imgs = files.filter((f) => !isPdf(f));
  if (pdfs.length && (pdfs.length > 1 || imgs.length || draft.pages.length || draft.pdf)) {
    alert('Cada recibo pode ser um PDF ou uma ou mais fotos, não os dois. Escolha um PDF de cada vez.');
    if (!modalOpen()) discardDraft();
    return;
  }
  if (imgs.length && draft.pdf) {
    alert('Este recibo já tem um PDF. Guarde-o primeiro e depois fotografe o próximo.');
    return;
  }
  const d = draft;
  busy = true;
  renderCapture('A preparar…');
  try {
    if (pdfs.length) {
      d.pdf = new Blob([await pdfs[0].arrayBuffer()], { type: 'application/pdf' });
      d.pdfName = pdfs[0].name;
    } else {
      for (const f of imgs) {
        const page = await toJpeg(f);
        page.url = URL.createObjectURL(page.blob);
        d.pages.push(page);
      }
    }
  } catch {
    alert('Não foi possível ler este ficheiro. Tente outra vez.');
  } finally {
    busy = false;
  }
  if (draft !== d) return;
  if (!d.pdf && !d.pages.length) { closeModal(); return; }
  renderCapture();
}

function projectOptions(selected, withNew) {
  const opts = state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`);
  if (withNew) opts.push(`<option value="__new" ${selected === '__new' ? 'selected' : ''}>+ Novo projeto…</option>`);
  return opts.join('');
}

function renderCapture(status) {
  const d = draft;
  const kind = d.pdf ? d.pdfName : plural(d.pages.length, 'página', 'páginas');
  const thumbs = d.pdf
    ? `<div class="page-thumb"><div class="doc">${icon('document-pdf')}</div></div>`
    : d.pages.map((p, i) => `<div class="page-thumb"><img src="${p.url}" alt="Página ${i + 1}"><button type="button" data-remove-page="${i}" aria-label="Remover página ${i + 1}">${icon('close')}</button></div>`).join('')
      + `<button type="button" class="add-page" id="cap-add">${icon('add')}Página</button>`;
  const spec = {
    title: 'Novo recibo',
    body: `
      <p class="muted">${esc(status || kind)}</p>
      <div class="pages">${thumbs}</div>
      ${selectField('cap-project', 'Projeto', projectOptions(d.projectId, true))}
      <div id="cap-new-wrap" ${d.projectId === '__new' ? '' : 'hidden'}>${textField('cap-new', 'Nome do novo projeto', d.newName)}</div>`,
    actions: [
      { id: 'cap-cancel', label: 'Cancelar', kind: 'secondary' },
      { id: 'cap-save', label: 'Guardar', kind: 'primary', disabled: busy },
    ],
  };
  if (modalOpen()) setModal(spec);
  else openModal(spec, discardDraft);

  $('cap-project').onchange = (e) => {
    d.projectId = e.target.value;
    $('cap-new-wrap').hidden = d.projectId !== '__new';
    if (d.projectId === '__new') $('cap-new').focus();
  };
  $('cap-new').oninput = (e) => { d.newName = e.target.value; };
  $('cap-cancel').onclick = () => { if (!busy) closeModal(); };
  $('cap-save').onclick = saveDraft;
  $('cap-add')?.addEventListener('click', () => $('photo-input').click());
  document.querySelectorAll('[data-remove-page]').forEach((b) => b.addEventListener('click', () => {
    const [p] = d.pages.splice(Number(b.dataset.removePage), 1);
    URL.revokeObjectURL(p.url);
    if (!d.pages.length) closeModal(); else renderCapture();
  }));
}

async function saveDraft() {
  const d = draft;
  if (!d || busy || (!d.pdf && !d.pages.length)) return;
  busy = true;
  $('cap-save').disabled = true;
  let projectId = d.projectId;
  if (projectId === '__new') {
    const p = await createProject(d.newName);
    if (!p) { busy = false; $('cap-save').disabled = false; return; }
    projectId = p.id;
    d.projectId = p.id;
  }
  try {
    let blob, ext, pageCount = null, thumb = null;
    if (d.pdf) {
      blob = d.pdf;
      ext = 'pdf';
    } else if (d.pages.length === 1) {
      blob = d.pages[0].blob;
      ext = 'jpg';
      pageCount = 1;
      thumb = (await toJpeg(blob, 240, 0.7)).blob; // miniatura leve para a lista
    } else {
      const parts = await Promise.all(d.pages.map(async (p) => ({ bytes: new Uint8Array(await p.blob.arrayBuffer()), width: p.width, height: p.height })));
      blob = makePdf(parts);
      ext = 'pdf';
      pageCount = d.pages.length;
      thumb = (await toJpeg(d.pages[0].blob, 240, 0.7)).blob;
    }
    const now = new Date();
    const note = { id: uid(), createdAt: now.toISOString(), month: localMonth(now), stamp: localStamp(now), projectId, ext, blob, thumb, pageCount, size: blob.size, sentAt: null };
    await putOne('notes', note);
    state.notes.unshift(note);
    state.settings.lastProject = projectId;
    await saveSettings();
    navigator.storage?.persist?.().catch(() => {});
    busy = false;
    closeModal();
    check();
    render();
  } catch (err) {
    busy = false;
    if ($('cap-save')) $('cap-save').disabled = false;
    alert(`Não foi possível guardar o recibo. ${err?.name === 'QuotaExceededError' ? 'O armazenamento está cheio.' : 'Tente outra vez.'}`);
  }
}

// ---------- projetos ----------
let creatingProject = false; // um segundo toque enquanto grava não faz nada
async function createProject(rawName) {
  if (creatingProject) return null;
  const name = String(rawName || '').trim();
  if (!name) { alert('Escreva o nome do projeto.'); return null; }
  if (state.projects.some((p) => collator.compare(p.name, name) === 0)) { alert('Já existe um projeto com este nome.'); return null; }
  const p = { id: uid(), name, createdAt: new Date().toISOString() };
  creatingProject = true;
  try {
    await putOne('projects', p);
  } catch {
    alert('Não foi possível guardar o projeto. Tente outra vez.');
    return null;
  } finally {
    creatingProject = false;
  }
  state.projects.push(p);
  state.projects.sort(byName);
  return p;
}

$('add-project-form').onsubmit = async (e) => {
  e.preventDefault();
  const p = await createProject($('new-project').value);
  if (p) { $('new-project').value = ''; check(); render(); }
};

function openProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const all = state.notes.filter((n) => n.projectId === id);
  openModal({
    title: p.name,
    label: 'Projeto',
    body: `<p class="muted">${plural(all.filter((n) => !n.sentAt).length, 'recibo por enviar', 'recibos por enviar')}, ${plural(all.filter((n) => n.sentAt).length, 'enviado', 'enviados')}.</p>
      ${textField('edit-name', 'Nome do projeto', p.name)}`,
    actions: [
      { id: 'edit-del', label: 'Eliminar', kind: 'danger--tertiary' },
      { id: 'edit-save', label: 'Guardar nome', kind: 'primary' },
    ],
  });
  $('edit-del').onclick = () => removeProject(id);
  $('edit-save').onclick = async () => {
    const name = $('edit-name').value.trim();
    if (!name) { alert('Escreva o nome do projeto.'); return; }
    if (state.projects.some((x) => x.id !== id && collator.compare(x.name, name) === 0)) { alert('Já existe um projeto com este nome.'); return; }
    p.name = name;
    await putOne('projects', p);
    state.projects.sort(byName);
    closeModal();
    check();
    render();
  };
}

async function removeProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const count = state.notes.filter((n) => n.projectId === id).length;
  if (count) { alert(`O projeto "${p.name}" tem ${plural(count, 'recibo', 'recibos')}. ${count === 1 ? 'Mude-o de projeto ou apague-o' : 'Mude-os de projeto ou apague-os'} antes de eliminar o projeto.`); return; }
  if (!confirm(`Eliminar o projeto "${p.name}"?`)) return;
  await delOne('projects', id);
  state.projects = state.projects.filter((x) => x.id !== id);
  if (state.settings.lastProject === id) { state.settings.lastProject = null; await saveSettings(); }
  closeModal();
  toast('Projeto eliminado');
  render();
}

// ---------- detalhe de um recibo ----------
function openNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  const url = URL.createObjectURL(n.blob);
  openModal({
    title: projectName(n.projectId),
    label: fmtDateTime(n.createdAt),
    body: `<p class="muted">${kindOf(n)} · ${fmtSize(n.size)}${n.sentAt ? ` · enviado em ${fmtDate(n.sentAt)}` : ''}</p>
      ${n.ext === 'jpg'
        ? `<img class="preview" src="${url}" alt="Recibo">`
        : `<a class="cds--btn cds--btn--tertiary cds--btn--xl cds--layout--size-xl full" href="${url}" target="_blank" rel="noopener">Abrir PDF${icon('document-pdf', 'cds--btn__icon')}</a>`}
      ${selectField('det-project', 'Mudar de projeto', projectOptions(n.projectId, false))}`,
    actions: [
      { id: 'det-del', label: 'Apagar', kind: 'danger--tertiary' },
      { id: 'det-close', label: 'Fechar', kind: 'primary' },
    ],
  }, () => URL.revokeObjectURL(url));
  $('det-close').onclick = closeModal;
  $('det-project').onchange = async (e) => {
    n.projectId = e.target.value;
    await putOne('notes', n);
    closeModal();
    check();
    render();
  };
  $('det-del').onclick = async () => {
    if (!confirm('Apagar este recibo? Não pode ser recuperado.')) return;
    await delOne('notes', n.id);
    state.notes = state.notes.filter((x) => x.id !== n.id);
    dropThumb(n.id);
    closeModal();
    toast('Recibo apagado');
    render();
  };
}

// ---------- fechar e enviar ----------
function groupByMonth(notes) {
  const m = new Map();
  for (const n of notes) {
    if (!m.has(n.month)) m.set(n.month, []);
    m.get(n.month).push(n);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function startClose() {
  const pending = pendingNotes();
  if (!pending.length) { alert('Não há recibos por enviar.'); return; }
  const months = groupByMonth(pending);
  const total = pending.reduce((s, n) => s + n.size, 0);
  const tooBig = total > MAIL_LIMIT;
  openModal({
    title: 'Fechar o mês',
    body: `<p>${plural(pending.length, 'recibo', 'recibos')} · ${fmtSize(total)}</p>
      ${tooBig ? notification('warning', 'Grande demais para um e-mail', 'Escolha os meses a enviar agora.') : ''}
      <fieldset class="cds--fieldset" id="close-months" ${tooBig ? '' : 'hidden'}>
        ${months.map(([m, ns], i) => `<div class="cds--checkbox-wrapper"><input type="checkbox" class="cds--checkbox" id="cm-${i}" value="${m}" checked><label for="cm-${i}" class="cds--checkbox-label"><span class="cds--checkbox-label-text">${monthLabel(m)}: ${plural(ns.length, 'recibo', 'recibos')}, ${fmtSize(ns.reduce((s, n) => s + n.size, 0))}</span></label></div>`).join('')}
      </fieldset>
`,
    actions: [
      { id: 'close-cancel', label: 'Cancelar', kind: 'secondary' },
      { id: 'close-go', label: 'Continuar', kind: 'primary' },
    ],
  });
  $('close-cancel').onclick = closeModal;
  $('close-go').onclick = async () => {
    const chosen = new Set([...document.querySelectorAll('#close-months input:checked')].map((i) => i.value));
    const notes = pending.filter((n) => chosen.has(n.month));
    if (!notes.length) { alert('Escolha pelo menos um mês.'); return; }
    busy = true;
    $('close-go').disabled = true;
    $('close-go').textContent = 'A preparar…';
    try {
      const pkg = await buildPackage(notes);
      busy = false;
      showShare(pkg, notes);
    } catch {
      busy = false;
      closeModal();
      alert('Não foi possível criar o ZIP. Tente outra vez.');
    }
  };
}

// Uma pasta por mês e, dentro, uma por projeto. Devolve as entradas do ZIP e o caminho de cada recibo.
async function zipEntries(notes) {
  const used = new Set();
  const entries = [];
  const paths = new Map();
  const sorted = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const n of sorted) {
    const base = `${n.month}/${safeName(projectName(n.projectId))}/${n.stamp}`;
    let path = `${base}.${n.ext}`;
    for (let i = 2; used.has(path); i++) path = `${base}_${i}.${n.ext}`;
    used.add(path);
    paths.set(n.id, path);
    entries.push({ path, bytes: new Uint8Array(await n.blob.arrayBuffer()), date: new Date(n.createdAt) });
  }
  return { entries, paths };
}

// O Outlook usa o nome do ficheiro como assunto e junta as linhas do texto numa só,
// por isso o nome é o assunto e o texto é uma frase curta.
async function buildPackage(notes) {
  const { entries } = await zipEntries(notes);
  const months = [...new Set(notes.map((n) => n.month))].sort();
  const org = state.settings.org.trim();
  const period = months.length > 1 ? `${monthLabel(months[0])} a ${monthLabel(months.at(-1))}` : monthLabel(months[0]);
  const subject = `Recibos${org ? ` ${org}` : ''}, ${period}`;
  const body = `Olá, seguem em anexo ${notes.length === 1 ? 'o recibo' : `os ${notes.length} recibos`} de ${period}, organizados por projeto.`;
  const file = new File([makeZip(entries)], `${safeName(subject)}.zip`, { type: 'application/zip' });
  return { file, subject, body };
}

// A partilha tem de ser chamada logo a seguir a um toque, por isso o ZIP é preparado antes.
function showShare(pkg, notes) {
  const canShare = !!navigator.canShare?.({ files: [pkg.file] });
  setModal({
    title: 'Pronto para enviar',
    body: `<p class="muted">${esc(pkg.file.name)} · ${fmtSize(pkg.file.size)}</p>`,
    actions: [
      { id: 'share-cancel', label: 'Cancelar', kind: 'secondary' },
      { id: 'share-go', label: canShare ? 'Enviar por e-mail' : 'Descarregar', kind: 'primary' },
    ],
  });
  $('share-cancel').onclick = closeModal;
  $('share-go').onclick = async () => {
    if (canShare) {
      try {
        await navigator.share({ files: [pkg.file], title: pkg.subject, text: pkg.body });
      } catch (err) {
        if (err?.name === 'AbortError') return; // fechou a folha de partilha: nada muda
        download(pkg.file);
      }
    } else {
      download(pkg.file);
    }
    askSent(notes);
  };
}

function download(file) {
  const u = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = u;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

function askSent(notes) {
  setModal({
    title: 'O e-mail foi enviado?',
    body: '',
    actions: [
      { id: 'sent-no', label: 'Ainda não', kind: 'secondary' },
      { id: 'sent-yes', label: 'Sim', kind: 'primary' },
    ],
  });
  $('sent-no').onclick = closeModal;
  $('sent-yes').onclick = async () => {
    const at = new Date().toISOString();
    await write('notes', (s) => notes.forEach((n) => s.put({ ...n, sentAt: at })));
    notes.forEach((n) => { n.sentAt = at; });
    closeModal();
    celebrate();
    render();
  };
}

async function deleteSentMonth(month) {
  const notes = state.notes.filter((n) => n.sentAt && n.month === month);
  if (!notes.length) return;
  if (!confirm(`Apagar ${plural(notes.length, 'recibo enviado', 'recibos enviados')} de ${monthLabel(month)} deste telemóvel? Não podem ser recuperados aqui.`)) return;
  await write('notes', (s) => notes.forEach((n) => s.delete(n.id)));
  const ids = new Set(notes.map((n) => n.id));
  state.notes = state.notes.filter((n) => !ids.has(n.id));
  ids.forEach(dropThumb);
  toast('Mês apagado');
  render();
}

$('close-action').onclick = startClose;

// ---------- cópia de segurança (iCloud Drive ou outra pasta, escolhida na partilha) ----------
const BACKUP_DATA = 'recibos-dados.json';
const BACKUP_DAYS = 30;

async function buildBackupFile() {
  const { entries, paths } = await zipEntries(state.notes);
  const data = {
    app: 'recibos',
    version: 1,
    createdAt: new Date().toISOString(),
    settings: { person: state.settings.person, org: state.settings.org },
    projects: state.projects,
    notes: state.notes.map(({ blob, thumb, ...n }) => ({ ...n, path: paths.get(n.id) })),
  };
  entries.push({ path: BACKUP_DATA, bytes: new TextEncoder().encode(JSON.stringify(data, null, 1)) });
  return new File([makeZip(entries)], 'Recibos.zip', { type: 'application/zip' });
}

// Partilha a cópia (Guardar em Ficheiros). Devolve true se foi guardada ou descarregada.
async function shareBackup(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err?.name === 'AbortError') return false;
      download(file);
    }
  } else {
    download(file);
  }
  state.settings.lastBackup = new Date().toISOString();
  await saveSettings();
  return true;
}

async function startBackup() {
  openModal({ title: 'Cópia de segurança', body: '<p class="muted">A preparar…</p>', closable: false });
  busy = true;
  try {
    const file = await buildBackupFile();
    busy = false;
    showBackupShare(file);
  } catch {
    busy = false;
    closeModal();
    alert('Não foi possível criar a cópia. Tente outra vez.');
  }
}

function showBackupShare(file) {
  const canShare = !!navigator.canShare?.({ files: [file] });
  setModal({
    title: 'Cópia pronta',
    body: `<p class="muted">${plural(state.notes.length, 'recibo', 'recibos')} · ${fmtSize(file.size)}</p>`,
    actions: [
      { id: 'bk-cancel', label: 'Cancelar', kind: 'secondary' },
      { id: 'bk-go', label: canShare ? 'Guardar em Ficheiros' : 'Descarregar', kind: 'primary' },
    ],
  });
  $('bk-cancel').onclick = closeModal;
  $('bk-go').onclick = async () => {
    if (!(await shareBackup(file))) return;
    closeModal();
    check();
    render();
  };
}

// A cópia pode vir de qualquer lado: só se aceita o formato que o app escreve.
const validDate = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));
const validNote = (n) => n && typeof n.id === 'string' && n.id.length <= 100 && typeof n.path === 'string' && validDate(n.createdAt)
  && /^\d{4}-(0[1-9]|1[0-2])$/.test(n.month) && /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n.stamp) && (n.ext === 'jpg' || n.ext === 'pdf')
  && (n.sentAt == null || validDate(n.sentAt)) && (n.pageCount == null || (Number.isInteger(n.pageCount) && n.pageCount > 0 && n.pageCount < 1000));

async function restoreFrom(file) {
  const notBackup = 'Este ficheiro não é uma cópia de segurança deste app.';
  let items, data;
  try {
    items = readZip(await file.arrayBuffer());
    const entry = items.find((i) => i.path === BACKUP_DATA);
    data = entry && JSON.parse(new TextDecoder().decode(entry.bytes));
  } catch {
    alert(notBackup);
    return;
  }
  if (!data || data.app !== 'recibos' || !Array.isArray(data.notes) || !Array.isArray(data.projects)) { alert(notBackup); return; }

  // Projetos: se já existe um com o mesmo nome, os recibos passam a usar esse.
  const idMap = new Map();
  const newProjects = [];
  for (const p of data.projects) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 100 || p.id === '__new' || typeof p.name !== 'string') continue;
    const name = p.name.trim().slice(0, 60);
    if (!name) continue;
    const same = state.projects.find((x) => x.id === p.id || collator.compare(x.name, name) === 0)
      || newProjects.find((x) => x.id === p.id || collator.compare(x.name, name) === 0);
    if (same) { idMap.set(p.id, same.id); continue; }
    const np = { id: p.id, name, createdAt: validDate(p.createdAt) ? p.createdAt : new Date().toISOString() };
    newProjects.push(np);
    idMap.set(p.id, np.id);
  }
  const byPath = new Map(items.map((i) => [i.path, i.bytes]));
  const have = new Set(state.notes.map((n) => n.id));
  // Cada recibo tem o seu ficheiro: ids ou ficheiros repetidos entram uma só vez.
  const usedPaths = new Set();
  const candidates = data.notes.filter((n) => {
    if (!validNote(n) || have.has(n.id) || !byPath.has(n.path) || usedPaths.has(n.path)) return false;
    have.add(n.id);
    usedPaths.add(n.path);
    return true;
  });
  if (!candidates.length && !newProjects.length) { alert('Esta cópia não tem nada que ainda não esteja neste telemóvel.'); return; }
  if (!confirm(`Restaurar ${plural(candidates.length, 'recibo', 'recibos')} e ${plural(newProjects.length, 'projeto novo', 'projetos novos')}? O que já existe neste telemóvel fica como está.`)) return;

  openModal({ title: 'A restaurar…', body: '<p>Não feche o app.</p>', closable: false });
  busy = true;
  try {
    const newNotes = [];
    for (const n of candidates) {
      const blob = new Blob([byPath.get(n.path)], { type: n.ext === 'jpg' ? 'image/jpeg' : 'application/pdf' });
      let thumb = null;
      if (n.ext === 'jpg') { try { thumb = (await toJpeg(blob, 240, 0.7)).blob; } catch {} }
      newNotes.push({
        id: n.id, createdAt: n.createdAt, month: n.month, stamp: n.stamp, ext: n.ext,
        projectId: idMap.get(n.projectId) || n.projectId, pageCount: n.pageCount ?? null,
        sentAt: typeof n.sentAt === 'string' ? n.sentAt : null, blob, thumb, size: blob.size,
      });
    }
    // Recibos cujo projeto não veio na cópia ficam num projeto "Recuperados".
    const known = new Set([...state.projects, ...newProjects].map((p) => p.id));
    if (newNotes.some((n) => !known.has(n.projectId))) {
      let rec = [...state.projects, ...newProjects].find((p) => collator.compare(p.name, 'Recuperados') === 0);
      if (!rec) { rec = { id: uid(), name: 'Recuperados', createdAt: new Date().toISOString() }; newProjects.push(rec); }
      newNotes.forEach((n) => { if (!known.has(n.projectId)) n.projectId = rec.id; });
    }
    await write('projects', (s) => newProjects.forEach((p) => s.put(p)));
    await write('notes', (s) => newNotes.forEach((n) => s.put(n)));
    if (!state.settings.person && !state.settings.org && data.settings) {
      state.settings.person = String(data.settings.person || '').slice(0, 60);
      state.settings.org = String(data.settings.org || '').slice(0, 60);
      await saveSettings();
    }
    await load();
    busy = false;
    closeModal();
    check();
    render();
  } catch (err) {
    busy = false;
    closeModal();
    alert(`Não foi possível restaurar. ${err?.name === 'QuotaExceededError' ? 'O armazenamento está cheio.' : 'Tente outra vez.'}`);
  }
}

$('backup-action').onclick = startBackup;
$('restore-action').onclick = () => $('restore-input').click();
$('restore-input').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) restoreFrom(f);
};
const backupDue = () => state.notes.length > 0
  && (!state.settings.lastBackup || Date.now() - new Date(state.settings.lastBackup).getTime() > BACKUP_DAYS * 864e5);

// ---------- primeira abertura ----------
const ob = { step: 0, backup: null };
const needsOnboarding = () => !state.settings.onboarded && !state.settings.person && !state.settings.org && !state.notes.length;
const obSteps = () => [...(isIOS() && !isStandalone() ? ['install'] : []), 'who', 'projects', 'backup'];

function showOnboarding() {
  ob.step = 0;
  $('onboarding').hidden = false;
  document.body.classList.add('cds--body--with-modal-open');
  setBackgroundInert(true);
  renderOnboarding();
}
async function finishOnboarding() {
  state.settings.onboarded = true;
  await saveSettings();
  $('onboarding').hidden = true;
  document.body.classList.remove('cds--body--with-modal-open');
  setBackgroundInert(false);
  render();
  typeHello();
}
function nextStep() { ob.step++; renderOnboarding(); }

function renderOnboarding() {
  const steps = obSteps();
  const key = steps[ob.step];
  if (!key) { finishOnboarding(); return; }
  const count = `${ob.step + 1} de ${steps.length}`;
  let body = '';
  let actions = '';
  if (key === 'install') {
    body = `<h1 class="title">Adicione ao ecrã principal</h1>
      <ol class="ob-list">
        <li>Toque em ${icon('ios-share', 'inline-ico')} <b>Partilhar</b> no Safari</li>
        <li>Toque em <b>Adicionar ao ecrã principal</b></li>
        <li>Abra o app pelo ícone novo</li>
      </ol>`;
    actions = `<button type="button" class="cds--btn cds--btn--tertiary cds--btn--xl cds--layout--size-xl full" id="ob-skip">Continuar no Safari</button>`;
  } else if (key === 'who') {
    body = `<h1 class="title">Como se chama?</h1>
      ${textField('ob-person', 'O seu nome', state.settings.person, { autocomplete: 'name' })}
      ${textField('ob-org', 'Organização', state.settings.org, { autocomplete: 'organization' })}`;
    actions = `<button type="button" class="cds--btn cds--btn--primary cds--btn--xl cds--layout--size-xl full" id="ob-next">Continuar</button>`;
  } else if (key === 'projects') {
    body = `<h1 class="title">Em que projetos trabalha?</h1>
      <div class="ob-add">
        ${textField('ob-project', 'Nome do projeto', '', { placeholder: 'Ex.: Obra Rua Augusta' })}
        <button type="button" class="cds--btn cds--btn--tertiary cds--btn--xl cds--layout--size-xl full" id="ob-add">Adicionar${icon('add', 'cds--btn__icon')}</button>
      </div>
      ${state.projects.length ? `<ul class="ob-projects">${state.projects.map((p) => `<li>${icon('checkmark')}${esc(p.name)}</li>`).join('')}</ul>` : ''}`;
    actions = `<button type="button" class="cds--btn cds--btn--primary cds--btn--xl cds--layout--size-xl full" id="ob-next">${state.projects.length ? 'Continuar' : 'Saltar'}</button>`;
  } else if (key === 'backup') {
    body = `<h1 class="title">Onde guardar as cópias de segurança?</h1>
      <p class="lead-plain">Escolha uma pasta no iCloud Drive.</p>`;
    actions = `<button type="button" class="cds--btn cds--btn--primary cds--btn--xl cds--layout--size-xl full" id="ob-backup" disabled>A preparar…</button>
      <button type="button" class="cds--btn cds--btn--tertiary cds--btn--xl cds--layout--size-xl full" id="ob-later">Agora não</button>`;
  }
  $('onboarding').innerHTML = `<div class="ob-inner">
    <div class="ob-body"><p class="label">${count}</p>${body}</div>
    <div class="ob-actions">${actions}</div>
  </div>`;
  $('onboarding').scrollTop = 0;

  $('ob-skip')?.addEventListener('click', nextStep);
  if (key === 'who') {
    $('ob-person').focus();
    $('ob-next').onclick = async () => {
      const person = $('ob-person').value.trim();
      if (!person) { alert('Escreva o seu nome.'); $('ob-person').focus(); return; }
      state.settings.person = person;
      state.settings.org = $('ob-org').value.trim();
      await saveSettings();
      nextStep();
    };
  }
  if (key === 'projects') {
    const add = async () => {
      if (await createProject($('ob-project').value)) renderOnboarding();
      $('ob-project')?.focus();
    };
    $('ob-add').onclick = add;
    $('ob-project').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    $('ob-next').onclick = nextStep;
  }
  if (key === 'backup') {
    $('ob-later').onclick = finishOnboarding;
    // O ficheiro é preparado antes: a partilha tem de vir logo a seguir ao toque.
    buildBackupFile().then((file) => {
      ob.backup = file;
      const b = $('ob-backup');
      if (!b) return;
      b.disabled = false;
      b.textContent = 'Escolher pasta';
      b.onclick = async () => {
        if (await shareBackup(ob.backup)) finishOnboarding();
      };
    }).catch(() => finishOnboarding());
  }
}

// ---------- ecrãs ----------
function noteItem(n) {
  const t = thumbUrl(n);
  return `<li class="cds--contained-list-item cds--contained-list-item--clickable">
    <button type="button" class="cds--contained-list-item__content item" data-note="${esc(n.id)}">
      ${t ? `<img class="thumb" src="${t}" alt="">` : `<span class="thumb">${icon('document-pdf')}</span>`}
      <span class="item-meta"><strong>${fmtDateTime(n.createdAt)}</strong><small>${kindOf(n)} · ${fmtSize(n.size)}</small></span>
      ${icon('chevron-right', 'chev')}
    </button>
  </li>`;
}

function renderNotes() {
  document.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('cds--content-switcher--selected', on);
    b.setAttribute('aria-selected', String(on));
  });
  const sent = state.view === 'sent';
  const notes = state.notes.filter((n) => (sent ? n.sentAt : !n.sentAt));
  if (!notes.length) {
    $('notes-list').innerHTML = `<p class="empty">${sent ? 'Ainda não há recibos enviados.' : 'Não há recibos por enviar. Fotografe um recibo no Início.'}</p>`;
    return;
  }
  $('notes-list').innerHTML = groupByMonth(notes).map(([m, ns]) => {
    const byProject = new Map();
    ns.forEach((n) => {
      const name = projectName(n.projectId);
      if (!byProject.has(name)) byProject.set(name, []);
      byProject.get(name).push(n);
    });
    const projects = [...byProject.entries()].sort((a, b) => collator.compare(a[0], b[0]));
    return `<section class="month">
      <div class="month-head"><h2>${monthLabel(m)}</h2><span class="cds--tag cds--tag--gray">${plural(ns.length, 'recibo', 'recibos')}</span></div>
      ${projects.map(([p, list]) => `<div class="cds--contained-list cds--contained-list--on-page cds--contained-list--lg">
        <div class="cds--contained-list__header"><div class="cds--contained-list__label">${esc(p)} · ${list.length}</div></div>
        <ul>${list.map(noteItem).join('')}</ul>
      </div>`).join('')}
      ${sent ? `<button type="button" class="cds--btn cds--btn--danger--tertiary cds--btn--lg cds--layout--size-lg full" data-delete-month="${m}">Apagar ${monthLabel(m)} deste telemóvel${icon('trash-can', 'cds--btn__icon')}</button>` : ''}
    </section>`;
  }).join('');
  document.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => openNote(b.dataset.note)));
  document.querySelectorAll('[data-delete-month]').forEach((b) => b.addEventListener('click', () => deleteSentMonth(b.dataset.deleteMonth)));
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; renderNotes(); }));

function renderProjects() {
  if (!state.projects.length) {
    $('projects-list').innerHTML = '<p class="empty">Ainda não há projetos. Crie o primeiro acima, ou ao guardar um recibo.</p>';
    return;
  }
  $('projects-list').innerHTML = `<div class="cds--contained-list cds--contained-list--on-page cds--contained-list--lg">
    <div class="cds--contained-list__header"><div class="cds--contained-list__label">${plural(state.projects.length, 'projeto', 'projetos')}</div></div>
    <ul>${state.projects.map((p) => {
      const all = state.notes.filter((n) => n.projectId === p.id);
      const pend = all.filter((n) => !n.sentAt).length;
      return `<li class="cds--contained-list-item cds--contained-list-item--clickable">
        <button type="button" class="cds--contained-list-item__content item" data-project="${esc(p.id)}">
          <span class="item-meta"><strong>${esc(p.name)}</strong><small>${plural(pend, 'recibo por enviar', 'recibos por enviar')}${all.length > pend ? `, ${all.length - pend} enviados` : ''}</small></span>
          ${icon('chevron-right', 'chev')}
        </button>
      </li>`;
    }).join('')}</ul>
  </div>`;
  document.querySelectorAll('[data-project]').forEach((b) => b.addEventListener('click', () => openProject(b.dataset.project)));
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

// "Olá, nome." aparece como se estivesse a ser escrito, ao abrir o app e ao voltar a ele.
let helloText = 'Olá.';
let typingTimer = null;
function typeHello() {
  const el = $('hello-text');
  const h1 = $('hello');
  clearTimeout(typingTimer);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = helloText; typingTimer = null; return; }
  const text = helloText;
  let i = 0;
  el.textContent = '';
  h1.classList.add('is-typing');
  const step = () => {
    el.textContent = text.slice(0, ++i);
    if (i < text.length) {
      typingTimer = setTimeout(step, text[i - 1] === ',' ? 260 : 80); // pausa curta depois de "Olá,"
    } else {
      typingTimer = null;
      setTimeout(() => h1.classList.remove('is-typing'), 900);
    }
  };
  typingTimer = setTimeout(step, 250);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('inicio').classList.contains('is-active') && $('onboarding').hidden) typeHello();
});

function renderHome() {
  const { person, org } = state.settings;
  helloText = person.trim() ? `Olá, ${person.trim()}.` : 'Olá.';
  $('hello').setAttribute('aria-label', helloText);
  if (!typingTimer) $('hello-text').textContent = helloText;
  const notices = [];
  if (isIOS() && !isStandalone()) {
    notices.push(notification('warning', 'Adicione ao ecrã principal', `${icon('ios-share', 'inline-ico')} <b>Partilhar</b> › <b>Adicionar ao ecrã principal</b>`));
  }
  if (backupDue()) {
    notices.push(notification('warning', 'Cópia de segurança em atraso', '', `<div class="notice-action"><button type="button" class="cds--btn cds--btn--tertiary cds--btn--lg cds--layout--size-lg" id="notice-backup">Guardar cópia</button></div>`));
  }
  $('home-notices').innerHTML = notices.join('');
  $('home-notices').hidden = !notices.length;
  $('notice-backup')?.addEventListener('click', startBackup);
  const pending = pendingNotes();
  const countEl = $('pending-count');
  if (countEl.textContent !== String(pending.length)) {
    countEl.textContent = String(pending.length);
    countEl.classList.remove('bump');
    void countEl.offsetWidth;
    countEl.classList.add('bump');
  }
  $('pending-detail').textContent = groupByMonth(pending).map(([m, ns]) => `${monthLabel(m)}: ${ns.length}`).join(' · ');
  $('pending-detail').hidden = !pending.length;
  $('close-action').disabled = !pending.length;
}

function renderHeader() {
  const org = state.settings.org.trim();
  document.title = org ? `Recibos ${org}` : 'Recibos';
}

function renderSettings() {
  if (document.activeElement?.id !== 'set-person') $('set-person').value = state.settings.person;
  if (document.activeElement?.id !== 'set-org') $('set-org').value = state.settings.org;
  $('backup-info').textContent = state.settings.lastBackup
    ? `Última cópia: ${fmtDateTime(state.settings.lastBackup)}`
    : 'Ainda sem cópia';
}

// Vai buscar a versão mais recente do app. Os recibos ficam guardados (IndexedDB não é tocado).
$('update-action').onclick = async () => {
  const b = $('update-action');
  b.disabled = true;
  b.firstChild.textContent = 'A atualizar…';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
  try { sessionStorage.setItem('recibos-updated', '1'); } catch {}
  location.reload();
};
$('app-version').textContent = `Versão ${APP_VERSION}`;

$('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  state.settings.person = $('set-person').value.trim();
  state.settings.org = $('set-org').value.trim();
  await saveSettings();
  check();
  render();
};

function render() {
  renderHeader();
  renderHome();
  renderNotes();
  renderProjects();
  renderSettings();
}

// ---------- arranque ----------
(async () => {
  try {
    db = await openDB();
    await load();
  } catch {
    document.querySelector('.app-main').innerHTML = notification('warning', 'Não é possível guardar dados', 'Abra o app no Safari, fora da navegação privada.');
    return;
  }
  render();
  if (needsOnboarding()) showOnboarding();
  // Depois de "Atualizar app": volta a Ajustes e confirma com o visto.
  let updated = false;
  try { updated = sessionStorage.getItem('recibos-updated') === '1'; sessionStorage.removeItem('recibos-updated'); } catch {}
  if (updated) { go('ajustes'); check(); } else if (!needsOnboarding()) typeHello();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
