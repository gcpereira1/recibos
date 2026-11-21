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
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'Sem nome';
const MAIL_LIMIT = 20e6; // limite prudente para anexos de e-mail

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

// URLs de pré-visualização: uma por recibo, libertadas quando o recibo é apagado.
const thumbUrls = new Map();
function thumbUrl(note) {
  const src = note.thumb;
  if (!src) return null;
  if (!thumbUrls.has(note.id)) thumbUrls.set(note.id, URL.createObjectURL(src));
  return thumbUrls.get(note.id);
}
function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(id);
}

// ---------- navegação e mensagens ----------
function go(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === id));
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  window.scrollTo({ top: 0 });
  render();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-go]');
  if (t) go(t.dataset.tab || t.dataset.go);
});

let toastTimer;
function toast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

let onModalClose = null;
let busy = false; // enquanto processa fotos ou guarda, a janela não fecha
function openModal(html, onClose) {
  $('dialog').innerHTML = html;
  $('modal').classList.remove('hidden');
  onModalClose = onClose || null;
}
function closeModal() {
  $('modal').classList.add('hidden');
  $('dialog').innerHTML = '';
  const fn = onModalClose;
  onModalClose = null;
  if (fn) fn();
}
const modalOpen = () => !$('modal').classList.contains('hidden');
$('modal').addEventListener('click', (e) => { if (e.target === $('modal') && !busy) closeModal(); });
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
  const kind = d.pdf
    ? `PDF: ${esc(d.pdfName)}`
    : d.pages.length > 1 ? `${d.pages.length} páginas, vão ser juntas num PDF` : d.pages.length ? '1 página' : '';
  const thumbs = d.pdf
    ? '<div class="page-thumb"><div class="thumb" style="width:100%;height:100%">PDF</div></div>'
    : d.pages.map((p, i) => `<div class="page-thumb"><img src="${p.url}" alt="Página ${i + 1}"><button type="button" data-remove-page="${i}" aria-label="Remover página ${i + 1}">×</button></div>`).join('')
      + '<button type="button" class="add-page" id="cap-add">+ Página</button>';
  const html = `
    <h2>Novo recibo</h2>
    <p class="muted">${status ? esc(status) : kind}</p>
    <div class="pages">${thumbs}</div>
    <label class="field">Projeto<select id="cap-project">${projectOptions(d.projectId, true)}</select></label>
    <label class="field ${d.projectId === '__new' ? '' : 'hidden'}" id="cap-new-wrap">Nome do novo projeto<input id="cap-new" maxlength="60" autocomplete="off" value="${esc(d.newName)}"></label>
    <div class="row-actions">
      <button type="button" class="secondary" id="cap-cancel">Cancelar</button>
      <button type="button" class="primary" id="cap-save" ${busy ? 'disabled' : ''}>Guardar</button>
    </div>`;
  if (modalOpen()) $('dialog').innerHTML = html;
  else openModal(html, discardDraft);

  $('cap-project').onchange = (e) => {
    d.projectId = e.target.value;
    $('cap-new-wrap').classList.toggle('hidden', d.projectId !== '__new');
    if (d.projectId === '__new') $('cap-new').focus();
  };
  $('cap-new').oninput = (e) => { d.newName = e.target.value; };
  $('cap-cancel').onclick = closeModal;
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
    toast(`Guardado em ${projectName(projectId)}`);
    render();
  } catch (err) {
    busy = false;
    if ($('cap-save')) $('cap-save').disabled = false;
    alert(`Não foi possível guardar o recibo. ${err?.name === 'QuotaExceededError' ? 'O armazenamento está cheio.' : 'Tente outra vez.'}`);
  }
}

// ---------- projetos ----------
async function createProject(rawName) {
  const name = String(rawName || '').trim();
  if (!name) { alert('Escreva o nome do projeto.'); return null; }
  if (state.projects.some((p) => collator.compare(p.name, name) === 0)) { alert('Já existe um projeto com este nome.'); return null; }
  const p = { id: uid(), name, createdAt: new Date().toISOString() };
  await putOne('projects', p);
  state.projects.push(p);
  state.projects.sort(byName);
  return p;
}

$('add-project-form').onsubmit = async (e) => {
  e.preventDefault();
  const p = await createProject($('new-project').value);
  if (p) { $('new-project').value = ''; render(); }
};

function editProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  openModal(`
    <h2>Editar projeto</h2>
    <label class="field">Nome<input id="edit-name" maxlength="60" value="${esc(p.name)}" autocomplete="off"></label>
    <div class="row-actions"><button class="secondary" id="edit-cancel">Cancelar</button><button class="primary" id="edit-save">Guardar</button></div>`);
  $('edit-cancel').onclick = closeModal;
  $('edit-save').onclick = async () => {
    const name = $('edit-name').value.trim();
    if (!name) { alert('Escreva o nome do projeto.'); return; }
    if (state.projects.some((x) => x.id !== id && collator.compare(x.name, name) === 0)) { alert('Já existe um projeto com este nome.'); return; }
    p.name = name;
    await putOne('projects', p);
    state.projects.sort(byName);
    closeModal();
    render();
  };
}

async function removeProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const count = state.notes.filter((n) => n.projectId === id).length;
  if (count) { alert(`O projeto "${p.name}" tem ${plural(count, 'recibo', 'recibos')}. Mude-os de projeto ou apague-os antes de eliminar o projeto.`); return; }
  if (!confirm(`Eliminar o projeto "${p.name}"?`)) return;
  await delOne('projects', id);
  state.projects = state.projects.filter((x) => x.id !== id);
  if (state.settings.lastProject === id) { state.settings.lastProject = null; await saveSettings(); }
  render();
}

// ---------- detalhe de um recibo ----------
function openNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  const url = URL.createObjectURL(n.blob);
  const kind = n.ext === 'jpg' ? 'Foto' : n.pageCount ? `PDF, ${n.pageCount} páginas` : 'PDF';
  openModal(`
    <h2>${esc(projectName(n.projectId))}</h2>
    <p class="muted">${fmtDateTime(n.createdAt)} · ${kind} · ${fmtSize(n.size)}${n.sentAt ? ` · enviado em ${fmtDate(n.sentAt)}` : ''}</p>
    ${n.ext === 'jpg' ? `<img class="preview" src="${url}" alt="Recibo">` : `<p><a class="secondary" style="display:inline-block;text-decoration:none" href="${url}" target="_blank" rel="noopener">Abrir PDF</a></p>`}
    <label class="field">Projeto<select id="det-project">${projectOptions(n.projectId, false)}</select></label>
    <div class="row-actions"><button class="danger-btn" id="det-del">Apagar</button><button class="primary" id="det-close">Fechar</button></div>`,
  () => URL.revokeObjectURL(url));
  $('det-close').onclick = closeModal;
  $('det-project').onchange = async (e) => {
    n.projectId = e.target.value;
    await putOne('notes', n);
    toast(`Movido para ${projectName(n.projectId)}`);
    closeModal();
    render();
  };
  $('det-del').onclick = async () => {
    if (!confirm('Apagar este recibo? Não pode ser recuperado.')) return;
    await delOne('notes', n.id);
    state.notes = state.notes.filter((x) => x.id !== n.id);
    dropThumb(n.id);
    closeModal();
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
  openModal(`
    <h2>Fechar e enviar</h2>
    <p class="muted">${plural(pending.length, 'recibo', 'recibos')} por enviar, ${fmtSize(total)}. O ZIP tem uma pasta por mês e, dentro, uma por projeto.</p>
    ${tooBig ? `<div class="notice warn">Pode ser grande demais para um só e-mail. Escolha os meses a enviar agora e envie os restantes noutro e-mail.</div>` : ''}
    <div id="close-months" class="${tooBig ? '' : 'hidden'}">
      ${months.map(([m, ns]) => `<label class="check"><input type="checkbox" value="${m}" checked> ${monthLabel(m)}: ${plural(ns.length, 'recibo', 'recibos')}, ${fmtSize(ns.reduce((s, n) => s + n.size, 0))}</label>`).join('')}
    </div>
    <p class="note">No ecrã seguinte escolha o Outlook e a destinatária. Para guardar uma cópia, escolha também "Guardar em Ficheiros".</p>
    <div class="row-actions"><button class="secondary" id="close-cancel">Cancelar</button><button class="primary" id="close-go">Preparar ZIP</button></div>`);
  $('close-cancel').onclick = closeModal;
  $('close-go').onclick = async () => {
    const chosen = new Set([...document.querySelectorAll('#close-months input:checked')].map((i) => i.value));
    const notes = pending.filter((n) => chosen.has(n.month));
    if (!notes.length) { alert('Escolha pelo menos um mês.'); return; }
    $('close-go').disabled = true;
    $('close-go').textContent = 'A preparar…';
    try {
      const pkg = await buildPackage(notes);
      showShare(pkg, notes);
    } catch {
      alert('Não foi possível criar o ZIP. Tente outra vez.');
      closeModal();
    }
  };
}

// Uma pasta por mês e, dentro, uma por projeto. Devolve as entradas do ZIP e o caminho de cada recibo.
async function zipEntries(notes, prefix = '') {
  const used = new Set();
  const entries = [];
  const paths = new Map();
  const sorted = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const n of sorted) {
    const base = `${prefix}${n.month}/${safeName(projectName(n.projectId))}/${n.stamp}`;
    let path = `${base}.${n.ext}`;
    for (let i = 2; used.has(path); i++) path = `${base}_${i}.${n.ext}`;
    used.add(path);
    paths.set(n.id, path);
    entries.push({ path, bytes: new Uint8Array(await n.blob.arrayBuffer()), date: new Date(n.createdAt) });
  }
  return { entries, paths };
}

async function buildPackage(notes) {
  const { entries } = await zipEntries(notes);
  const months = [...new Set(notes.map((n) => n.month))].sort();
  const org = state.settings.org.trim();
  const range = months.length > 1 ? `${months[0]} a ${months.at(-1)}` : months[0];
  const fileName = `${safeName(`Recibos${org ? ` ${org}` : ''} ${range}`)}.zip`;
  const monthsText = months.map(monthLabel).join(', ');
  const subject = `Recibos${org ? ` ${org}` : ''}, ${monthsText}`;
  const lines = ['Olá,', '', `Seguem em anexo os recibos${org ? ` de ${org}` : ''} de ${monthsText}.`, ''];
  for (const [m, ns] of groupByMonth(notes).reverse()) {
    lines.push(monthLabel(m));
    const perProject = new Map();
    ns.forEach((n) => perProject.set(projectName(n.projectId), (perProject.get(projectName(n.projectId)) || 0) + 1));
    [...perProject.entries()].sort((a, b) => collator.compare(a[0], b[0])).forEach(([p, c]) => lines.push(`- ${p}: ${c}`));
    lines.push('');
  }
  lines.push(`Total: ${plural(notes.length, 'recibo', 'recibos')}.`);
  if (state.settings.person.trim()) lines.push('', state.settings.person.trim());
  const file = new File([makeZip(entries)], fileName, { type: 'application/zip' });
  return { file, subject, body: lines.join('\n') };
}

// A partilha tem de ser chamada logo a seguir a um toque, por isso o ZIP é preparado antes.
function showShare(pkg, notes) {
  const canShare = !!navigator.canShare?.({ files: [pkg.file] });
  $('dialog').innerHTML = `
    <h2>ZIP pronto</h2>
    <p class="muted">${esc(pkg.file.name)} · ${plural(notes.length, 'recibo', 'recibos')} · ${fmtSize(pkg.file.size)}</p>
    <p class="note">${canShare ? 'Toque em Partilhar, escolha o Outlook e a destinatária, e envie.' : 'Este navegador não partilha ficheiros. O ZIP vai ser descarregado para anexar ao e-mail.'}</p>
    <div class="row-actions"><button class="secondary" id="share-cancel">Cancelar</button><button class="primary" id="share-go">${canShare ? 'Partilhar' : 'Descarregar'}</button></div>`;
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
  $('dialog').innerHTML = `
    <h2>O e-mail foi enviado?</h2>
    <p class="muted">Se sim, ${notes.length === 1 ? 'o recibo passa' : `os ${notes.length} recibos passam`} para "Enviados" e não volta${notes.length === 1 ? '' : 'm'} a entrar no próximo fecho.</p>
    <div class="row-actions"><button class="secondary" id="sent-no">Ainda não</button><button class="primary" id="sent-yes">Sim, enviado</button></div>`;
  $('sent-no').onclick = closeModal;
  $('sent-yes').onclick = async () => {
    const at = new Date().toISOString();
    await write('notes', (s) => notes.forEach((n) => s.put({ ...n, sentAt: at })));
    notes.forEach((n) => { n.sentAt = at; });
    closeModal();
    toast('Marcados como enviados');
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
  render();
}

$('close-action').onclick = startClose;

// ---------- cópia de segurança (iCloud Drive ou outra pasta, escolhida na partilha) ----------
const BACKUP_DATA = 'recibos-dados.json';
const BACKUP_DAYS = 30;

async function startBackup() {
  if (!state.notes.length && !state.projects.length) { alert('Ainda não há recibos nem projetos para guardar.'); return; }
  openModal('<h2>Cópia de segurança</h2><p class="muted">A preparar…</p>');
  busy = true;
  try {
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
    const file = new File([makeZip(entries)], `Copia recibos ${localStamp(new Date())}.zip`, { type: 'application/zip' });
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
  $('dialog').innerHTML = `
    <h2>Cópia pronta</h2>
    <p class="muted">${esc(file.name)} · ${plural(state.notes.length, 'recibo', 'recibos')} · ${fmtSize(file.size)}</p>
    <p class="note">${canShare
      ? 'Toque em Partilhar, escolha "Guardar em Ficheiros" e depois a pasta no iCloud Drive (por exemplo, uma pasta "Recibos"). O iPhone lembra-se da última pasta usada.'
      : 'O ZIP vai ser descarregado. Guarde-o numa pasta de cópias de segurança.'}</p>
    <div class="row-actions"><button class="secondary" id="bk-cancel">Cancelar</button><button class="primary" id="bk-go">${canShare ? 'Partilhar' : 'Descarregar'}</button></div>`;
  $('bk-cancel').onclick = closeModal;
  $('bk-go').onclick = async () => {
    if (canShare) {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        download(file);
      }
    } else {
      download(file);
    }
    state.settings.lastBackup = new Date().toISOString();
    await saveSettings();
    closeModal();
    toast('Cópia de segurança feita');
    render();
  };
}

const validNote = (n) => n && typeof n.id === 'string' && typeof n.path === 'string' && typeof n.createdAt === 'string'
  && /^\d{4}-\d{2}$/.test(n.month) && typeof n.stamp === 'string' && (n.ext === 'jpg' || n.ext === 'pdf');

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
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim()) continue;
    const same = state.projects.find((x) => x.id === p.id || collator.compare(x.name, p.name) === 0)
      || newProjects.find((x) => collator.compare(x.name, p.name) === 0);
    if (same) { idMap.set(p.id, same.id); continue; }
    const np = { id: p.id, name: p.name.trim().slice(0, 60), createdAt: p.createdAt || new Date().toISOString() };
    newProjects.push(np);
    idMap.set(p.id, np.id);
  }
  const byPath = new Map(items.map((i) => [i.path, i.bytes]));
  const have = new Set(state.notes.map((n) => n.id));
  const candidates = data.notes.filter((n) => validNote(n) && !have.has(n.id) && byPath.has(n.path));
  if (!candidates.length && !newProjects.length) { alert('Esta cópia não tem nada que ainda não esteja neste telemóvel.'); return; }
  if (!confirm(`Restaurar ${plural(candidates.length, 'recibo', 'recibos')} e ${plural(newProjects.length, 'projeto novo', 'projetos novos')}? O que já existe neste telemóvel fica como está.`)) return;

  openModal('<h2>A restaurar…</h2><p class="muted">Não feche o app.</p>');
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
    toast(`${plural(newNotes.length, 'recibo restaurado', 'recibos restaurados')}`);
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

// ---------- ecrãs ----------
function noteRow(n) {
  const t = thumbUrl(n);
  const kind = n.ext === 'jpg' ? 'Foto' : n.pageCount ? `PDF, ${n.pageCount} páginas` : 'PDF';
  return `<button class="row" data-note="${esc(n.id)}">
    ${t ? `<img class="thumb" src="${t}" alt="">` : '<span class="thumb">PDF</span>'}
    <span class="row-meta"><strong>${fmtDateTime(n.createdAt)}</strong><small>${kind} · ${fmtSize(n.size)}</small></span>
    <span aria-hidden="true">›</span>
  </button>`;
}

function renderNotes() {
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
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
    return `<div class="group-month"><span>${monthLabel(m)} · ${ns.length}</span>${sent ? `<button class="text-button danger" data-delete-month="${m}">Apagar mês</button>` : ''}</div>`
      + projects.map(([p, list]) => `<div class="group-project">${esc(p)} · ${list.length}</div>${list.map(noteRow).join('')}`).join('');
  }).join('');
  document.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => openNote(b.dataset.note)));
  document.querySelectorAll('[data-delete-month]').forEach((b) => b.addEventListener('click', () => deleteSentMonth(b.dataset.deleteMonth)));
}
document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; renderNotes(); }));

function renderProjects() {
  if (!state.projects.length) {
    $('projects-list').innerHTML = '<p class="empty">Ainda não há projetos. Crie o primeiro acima ou ao guardar um recibo.</p>';
    return;
  }
  $('projects-list').innerHTML = state.projects.map((p) => {
    const all = state.notes.filter((n) => n.projectId === p.id);
    const pend = all.filter((n) => !n.sentAt).length;
    return `<div class="project">
      <span class="letter">${esc(p.name.charAt(0).toUpperCase())}</span>
      <span class="project-meta"><strong>${esc(p.name)}</strong><small>${plural(pend, 'recibo por enviar', 'recibos por enviar')}${all.length > pend ? `, ${all.length - pend} enviados` : ''}</small></span>
      <button class="text-button" data-edit="${esc(p.id)}">Editar</button>
      <button class="text-button danger" data-remove="${esc(p.id)}">Eliminar</button>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editProject(b.dataset.edit)));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeProject(b.dataset.remove)));
}

function renderHome() {
  const { person, org } = state.settings;
  $('hello').textContent = person.trim() ? `Olá, ${person.trim()}.` : 'Olá.';
  $('hello-sub').textContent = person.trim() || org.trim() ? 'Fotografe cada recibo no momento da compra.' : 'Comece por pôr o seu nome e a organização em Ajustes.';
  const pending = pendingNotes();
  $('pending-count').textContent = plural(pending.length, 'recibo', 'recibos');
  $('pending-detail').textContent = groupByMonth(pending).map(([m, ns]) => `${monthLabel(m)}: ${ns.length}`).join(' · ');
  $('close-action').disabled = !pending.length;
  $('backup-hint').classList.toggle('hidden', !backupDue());
}

function renderHeader() {
  const org = state.settings.org.trim();
  $('brand').textContent = org || 'Recibos';
  $('brand-sub').textContent = org ? 'Recibos' : '';
  document.title = org ? `Recibos ${org}` : 'Recibos';
}

async function renderSettings() {
  if (document.activeElement?.id !== 'set-person') $('set-person').value = state.settings.person;
  if (document.activeElement?.id !== 'set-org') $('set-org').value = state.settings.org;
  const total = state.notes.reduce((s, n) => s + n.size, 0);
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch {}
  $('storage-info').textContent = `${plural(state.notes.length, 'recibo', 'recibos')} guardados, ${fmtSize(total)}.`
    + (persisted === true ? ' Armazenamento protegido.' : persisted === false ? ' Armazenamento ainda não protegido: instale o app no ecrã principal.' : '');
  $('backup-info').textContent = state.settings.lastBackup
    ? `Última cópia: ${fmtDateTime(state.settings.lastBackup)}.`
    : 'Ainda não fez nenhuma cópia.';
}

$('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  state.settings.person = $('set-person').value.trim();
  state.settings.org = $('set-org').value.trim();
  await saveSettings();
  toast('Ajustes guardados');
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
function showInstallHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('install-hint').classList.toggle('hidden', standalone || !ios);
}

(async () => {
  try {
    db = await openDB();
    await load();
  } catch {
    document.querySelector('.shell').innerHTML = '<p class="notice warn">Este navegador não permite guardar dados. Abra o app no Safari, fora do modo privado.</p>';
    return;
  }
  showInstallHint();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
