// Ứng dụng văn phòng ảo: dữ liệu, WebSocket, HUD, panel nhân viên, modal. Cảnh 3D nằm trong scene/office3d.js
import { Office3D, QUALITY } from './scene/office3d.js';

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const PROVIDER_LABEL = {
  'claude-code': 'Claude Code', 'codex': 'OpenAI Codex', 'anthropic-chat': 'Claude chat (API)',
  'openai-chat': 'OpenAI chat (API)', 'observer': 'Quan sát phiên',
};
const STATUS_LABEL = { idle: 'Rảnh', queued: 'Chờ việc', working: 'Đang làm', waiting: 'Xin duyệt', error: 'Lỗi', offline: 'Offline' };
const SHAPES = { zone: 'Khu cụm bàn', lounge: 'Lounge trung tâm', room: 'Phòng họp kính', cafe: 'Khu cà phê (giờ nghỉ)', game: 'Khu giải trí (giờ nghỉ)' };
const AMENITY = new Set(['cafe', 'game']);   // khu nghỉ: không xếp nhân viên vào
const THEMES = { docs: 'Văn bản', code: 'Code', design: 'Thiết kế', charts: 'Biểu đồ', media: 'Mạng xã hội', video: 'Dựng phim' };

// ---------------- Tiện ích
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`; };
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', ms); }
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-office-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------------- Tệp đính kèm (dán ảnh, kéo thả, chọn tệp)
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
const fileUrl = (a) => `/files/${a.id}/${encodeURIComponent(a.name)}?t=${encodeURIComponent(TOKEN)}`;
const extOf = (n) => (String(n).split('.').pop() || '').slice(0, 4);
const MAX_FILES = 10, MAX_SIZE = 25 * 1024 * 1024;

/** Khay đính kèm gắn vào 1 ô nhập: dán / kéo thả / nút chọn tệp, tự tải lên ngay */
function makeTray({ list: listEl, input, dropZone, fileInput, button }) {
  const items = [];
  const render = () => {
    listEl.innerHTML = items.map((it, i) => `
      <div class="att ${it.status === 'uploading' ? 'uploading' : ''} ${it.status === 'error' ? 'err' : ''}" title="${esc(it.name)}">
        ${it.preview ? `<img src="${it.preview}" alt="" />` : `<div class="ficon">${esc(extOf(it.name))}</div>`}
        <div class="nm">${esc(it.name)}<small>${it.status === 'uploading' ? 'đang tải lên…' : it.status === 'error' ? 'lỗi tải lên' : fmtSize(it.size)}</small></div>
        <button class="x" type="button" data-rm="${i}" title="Bỏ tệp">×</button>
      </div>`).join('');
  };
  listEl.addEventListener('click', e => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const [it] = items.splice(+b.dataset.rm, 1);
    if (it?.preview) URL.revokeObjectURL(it.preview);
    render();
  });
  async function add(files) {
    for (const f of files) {
      if (items.length >= MAX_FILES) { toast(`Tối đa ${MAX_FILES} tệp mỗi việc`); break; }
      if (f.size > MAX_SIZE) { toast(`${f.name} quá lớn (tối đa 25MB)`); continue; }
      let name = f.name || 'tep';
      if (/^image\.(png|jpe?g|gif|webp)$/i.test(name) || !f.name) { // ảnh dán từ clipboard
        const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        name = `anh-dan-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      }
      const it = { name, size: f.size, mime: f.type, status: 'uploading', preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      items.push(it); render();
      try {
        const r = await fetch('/api/uploads', { method: 'POST', body: f, headers: {
          'x-office-token': TOKEN, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-mime': f.type || '' } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText);
        it.id = j.id; it.status = 'ok';
      } catch (err) { it.status = 'error'; toast(`Không tải lên được ${name}: ${err.message}`); }
      render();
    }
  }
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault(); // chỉ có ảnh → không dán chữ rác
    add(files);
  });
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  dropZone.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  dropZone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dropZone.classList.remove('dragging'); } });
  dropZone.addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dropZone.classList.remove('dragging');
    add([...e.dataTransfer.files]);
  });
  button.onclick = () => fileInput.click();
  fileInput.onchange = () => { add([...fileInput.files]); fileInput.value = ''; };
  return {
    busy: () => items.some(it => it.status === 'uploading'),
    ids: () => items.filter(it => it.status === 'ok').map(it => it.id),
    count: () => items.filter(it => it.status === 'ok').length,
    clear: () => { items.forEach(it => it.preview && URL.revokeObjectURL(it.preview)); items.length = 0; render(); },
  };
}
const attHtml = (atts) => atts?.length ? `<div class="ev-atts">${atts.map(a => /^image\//.test(a.mime)
  ? `<a class="img" href="${fileUrl(a)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${fileUrl(a)}" alt="${esc(a.name)}" loading="lazy" /></a>`
  : `<a href="${fileUrl(a)}" title="Tải ${esc(a.name)}"><div class="ficon">${esc(extOf(a.name))}</div><span>${esc(a.name)}</span></a>`).join('')}</div>` : '';

// ---------------- Trạng thái
const state = { departments: [], agents: [], permissions: [], feed: [], providers: [], usageToday: null };
const fmtTok = (n) => !n ? '0' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n));
const fmtUsd = (v) => v >= 100 ? '$' + v.toFixed(0) : v >= 1 ? '$' + v.toFixed(2) : v > 0 ? '$' + v.toFixed(3) : '$0';
const fmtVnd = (v, rate) => rate ? ' · ' + Math.round(v * rate).toLocaleString('vi-VN') + '₫' : '';
const usageOf = (id) => state.usageToday?.agents.find(a => a.agentId === id);
let selectedId = null;
const agentById = (id) => state.agents.find(a => a.id === id);
const deptById = (id) => state.departments.find(d => d.id === id);

// ---------------- Cảnh 3D
const params = new URLSearchParams(location.search);
const office = new Office3D($('#stage'), {
  onPick: (id) => openPanel(id),
  onProgress: (msg) => { $('#loading-text').textContent = msg; },
});
if (params.get('q') && QUALITY[params.get('q')]) office.quality = params.get('q');
if (params.get('auto') === '0') office.autoQuality = false;
if (params.get('nghi') === 'nhanh') office.leisureSpeed = 10;   // thử nhanh cảnh đi nghỉ
office.onLeisure = () => renderHud();
office.onQualityAuto = (q) => { renderQuality(); toast(`Máy hơi chậm — đã chuyển chất lượng hình sang "${QUALITY[q]}"`); };

function renderQuality() { $('#btn-quality').textContent = `Chất lượng: ${QUALITY[office.quality]}`; }
$('#btn-quality').onclick = () => {
  const order = ['high', 'medium', 'low'];
  office.autoQuality = false;
  office.applyQuality(order[(order.indexOf(office.quality) + 1) % 3]);
  renderQuality();
};
$('#btn-overview').onclick = () => office.overview();

// ---------------- HUD & feed
function renderHud() {
  const working = state.agents.filter(a => a.status === 'working' || a.status === 'waiting');
  const lead = working.find(a => a.status === 'waiting') ?? working[0];
  if (lead) {
    const dept = deptById(lead.departmentId)?.name ?? '';
    $('#hud-title').textContent = lead.status === 'waiting' ? `${lead.name} cần bạn duyệt` : `${dept}: đang làm`;
    $('#hud-sub').textContent = lead.currentTask?.prompt?.slice(0, 110) || `${lead.name} · ${lead.role}`;
  } else {
    $('#hud-title').textContent = state.agents.length ? 'Văn phòng đang nghỉ' : 'Chưa có nhân viên';
    $('#hud-sub').textContent = state.agents.length ? 'Giao brief để cả nhà bắt đầu làm việc. Đèn chỉ sáng ở bàn có việc thật.' : 'Bấm “+ Nhân viên” để tuyển người đầu tiên.';
  }
  const q = state.agents.reduce((s, a) => s + (a.queued || 0), 0);
  const t = state.usageToday?.total;
  const spend = t && (t.input + t.output) > 0 ? ` · Hôm nay ${fmtTok(t.input + t.output + t.cacheRead + t.cacheWrite)} token${t.costUsd > 0 ? ' ~' + fmtUsd(t.costUsd) : ''}` : '';
  const lc = office.leisureCounts?.() ?? { cafe: 0, game: 0 };
  const rest = [lc.cafe && `${lc.cafe} người uống cà phê`, lc.game && `${lc.game} người chơi game`].filter(Boolean).join(', ');
  $('#hud-count').textContent = `${working.length} chuyên gia đang làm việc` + (q ? ` · ${q} việc đang chờ` : '') + ` · ${state.agents.length} nhân sự` + (rest ? ` · ${rest}` : '') + spend;
}
/** Dòng sự kiện góc dưới: chỉ giữ tin trong 2 phút gần nhất cho đỡ che khu cà phê / giải trí */
function renderFeed() {
  const fresh = state.feed.filter(e => Date.now() - e.ts < 120000);
  $('#feed').innerHTML = fresh.slice(-4).map(e => {
    const a = agentById(e.agentId);
    return `<div>${hhmm(e.ts)} · <b>${esc(a?.name ?? e.agentId)}</b>: ${esc(e.text.slice(0, 110))}</div>`;
  }).join('');
}

setInterval(renderFeed, 15000);

// ---------------- Panel nhân viên
async function openPanel(id) {
  selectedId = id; $('#panel').classList.add('open'); document.body.classList.add('panel-open'); renderPanel(); office.select(id);
  const evs = await api(`/agents/${id}/events?limit=200`).catch(() => []);
  if (selectedId !== id) return;
  $('#log').innerHTML = ''; evs.forEach(appendLog); $('#log').scrollTop = 1e9;
}
function closePanel() { selectedId = null; $('#panel').classList.remove('open'); document.body.classList.remove('panel-open'); office.select(null); }
function renderPanel() {
  const a = agentById(selectedId); if (!a) return closePanel();
  $('#p-name').textContent = a.name;
  $('#p-role').textContent = `${a.role || '—'} · ${deptById(a.departmentId)?.name ?? ''}`;
  const chips = [`<span class="chip status-${a.status}">${STATUS_LABEL[a.status] ?? a.status}</span>`, `<span class="chip">${PROVIDER_LABEL[a.provider]}</span>`];
  if (a.model) chips.push(`<span class="chip">${esc(a.model)}</span>`);
  if (a.permissionMode && !['anthropic-chat', 'openai-chat', 'observer'].includes(a.provider)) chips.push(`<span class="chip">quyền: ${a.permissionMode}</span>`);
  if (a.sessionId) chips.push(`<span class="chip" title="${esc(a.sessionId)}">phiên ${esc(a.sessionId.split(/[\\/]/).pop().slice(0, 10))}…</span>`);
  if (a.queued) chips.push(`<span class="chip status-queued">${a.queued} việc chờ</span>`);
  const u = usageOf(a.id);
  if (u) chips.push(`<span class="chip chip-cost" title="Token vào ${fmtTok(u.input)} · ra ${fmtTok(u.output)} · cache ${fmtTok(u.cacheRead + u.cacheWrite)}">Hôm nay: ${fmtTok(u.input + u.output + u.cacheRead + u.cacheWrite)} token${u.costUsd > 0 ? ' · ~' + fmtUsd(u.costUsd) : u.unpriced ? ' · chưa có giá' : ''}</span>`);
  $('#p-chips').innerHTML = chips.join('');
  const observer = a.provider === 'observer';
  $('#composer').style.display = observer ? 'none' : 'flex';
  $('#p-stop').style.display = observer ? 'none' : '';
  $('#p-reset').style.display = observer ? 'none' : '';
  renderPerms();
}
function renderPerms() {
  const list = state.permissions.filter(p => p.agentId === selectedId);
  $('#perms').innerHTML = list.map(p => `
    <div class="perm"><b>Xin quyền: ${esc(p.tool)}</b>
      <pre>${esc(JSON.stringify(p.input, null, 2).slice(0, 1500))}</pre>
      <button class="btn small primary" data-perm="${p.id}" data-allow="1">Cho phép</button>
      <button class="btn small danger" data-perm="${p.id}" data-allow="0">Từ chối</button>
    </div>`).join('');
}
$('#perms').addEventListener('click', async e => {
  const b = e.target.closest('[data-perm]'); if (!b) return;
  b.disabled = true;
  await api(`/permissions/${b.dataset.perm}`, 'POST', { allow: b.dataset.allow === '1' }).catch(err => toast(err.message));
});
function appendLog(e) {
  const el = document.createElement('div'); el.className = `ev k-${e.kind}`;
  el.innerHTML = `<time>${hhmm(e.ts)} · ${e.kind}</time>${esc(e.text)}${attHtml(e.data?.attachments)}`;
  const log = $('#log'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.appendChild(el); if (atBottom) log.scrollTop = 1e9;
}
const panelTray = makeTray({ list: $('#p-atts'), input: $('#p-input'), dropZone: $('#composer'), fileInput: $('#p-file'), button: $('#p-attach') });
async function sendTask() {
  const prompt = $('#p-input').value.trim(); if ((!prompt && !panelTray.count()) || !selectedId) return;
  if (panelTray.busy()) return toast('Đợi tải tệp lên xong rồi giao nhé');
  $('#p-send').disabled = true;
  try { await api(`/agents/${selectedId}/tasks`, 'POST', { prompt, attachments: panelTray.ids() }); $('#p-input').value = ''; panelTray.clear(); }
  catch (err) { toast(err.message); }
  finally { $('#p-send').disabled = false; }
}
$('#p-send').onclick = sendTask;
$('#p-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendTask(); });
$('#p-close').onclick = closePanel;
$('#p-focus').onclick = () => selectedId && office.flyTo(selectedId);
$('#p-stop').onclick = () => api(`/agents/${selectedId}/stop`, 'POST').then(r => toast(`Đã dừng${r.cancelledQueued ? `, huỷ ${r.cancelledQueued} việc chờ` : ''}`)).catch(e => toast(e.message));
$('#p-reset').onclick = () => confirm('Bắt đầu phiên mới? Nhân viên sẽ quên ngữ cảnh cũ.') && api(`/agents/${selectedId}/reset`, 'POST').catch(e => toast(e.message));
$('#p-del').onclick = () => { const a = agentById(selectedId); if (a && confirm(`Xoá ${a.name} khỏi văn phòng?`)) api(`/agents/${a.id}`, 'DELETE').then(closePanel).catch(e => toast(e.message)); };
$('#p-edit').onclick = () => agentForm(agentById(selectedId));

// ---------------- Modal
function openModal(html) { $('#modal-box').innerHTML = html; $('#modal').classList.add('open'); }
function closeModal() { $('#modal').classList.remove('open'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });
const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;

function agentForm(a = {}, isEdit = !!a.id && !!agentById(a.id)) {
  openModal(`
    <h3>${isEdit ? 'Sửa nhân viên' : 'Tuyển nhân viên mới'}</h3>
    <form id="agent-form">
      <div class="row2">
        <div class="field"><label>Tên hiển thị</label><input name="name" required value="${esc(a.name)}" /></div>
        <div class="field"><label>Phòng ban</label><select name="departmentId">${state.departments.filter(d => !AMENITY.has(d.style?.shape)).map(d => opt(d.id, a.departmentId, d.name)).join('')}</select></div>
      </div>
      <div class="field"><label>Vai trò</label><input name="role" value="${esc(a.role)}" placeholder="VD: Viết copy Naver tiếng Hàn" /></div>
      <div class="row2">
        <div class="field"><label>Loại nhân viên</label><select name="provider">${state.providers.map(p => opt(p, a.provider ?? 'claude-code', PROVIDER_LABEL[p])).join('')}</select></div>
        <div class="field" data-for="claude-code codex anthropic-chat openai-chat"><label>Model (bỏ trống = mặc định)</label><input name="model" value="${esc(a.model)}" /></div>
      </div>
      <div class="field" data-for="claude-code codex"><label>Thư mục làm việc (cwd)</label><input name="cwd" value="${esc(a.cwd)}" placeholder="C:\\du-an\\web hoặc /home/ban/du-an" /><small>Agent chỉ nên đọc/ghi trong thư mục này.</small></div>
      <div class="field" data-for="claude-code codex"><label>Quyền</label><select name="permissionMode">
        ${opt('default', a.permissionMode ?? 'default', 'Hỏi trước khi sửa file / chạy lệnh')}
        ${opt('acceptEdits', a.permissionMode, 'Tự sửa file, hỏi khi chạy lệnh')}
        ${opt('plan', a.permissionMode, 'Chỉ đọc & lập kế hoạch')}
        ${opt('bypassPermissions', a.permissionMode, '⚠ Toàn quyền, không hỏi')}
      </select></div>
      <div class="field" data-for="observer claude-code codex openai-chat"><label>Session / thread ID ${a.provider === 'observer' ? '(đường dẫn file JSONL)' : '(bỏ trống = phiên mới)'}</label><input name="sessionId" value="${esc(a.sessionId)}" /></div>
      <div class="field" data-for="claude-code codex anthropic-chat openai-chat"><label>Hướng dẫn riêng (system prompt)</label><textarea name="systemPrompt">${esc(a.systemPrompt)}</textarea></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary">${isEdit ? 'Lưu' : 'Tuyển'}</button></div>
    </form>`);
  const form = $('#agent-form');
  const sync = () => { const p = form.provider.value; form.querySelectorAll('[data-for]').forEach(el => el.style.display = el.dataset.for.split(' ').includes(p) ? '' : 'none'); };
  form.provider.onchange = sync; sync();
  form.onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      if (body.permissionMode === 'bypassPermissions' && !confirm('Toàn quyền: agent có thể chạy MỌI lệnh trên máy bạn mà không hỏi. Chắc chắn?')) return;
      if (isEdit) await api(`/agents/${a.id}`, 'PATCH', body);
      else { const c = await api('/agents', 'POST', body); setTimeout(() => openPanel(c.id), 400); }
      closeModal();
    } catch (err) { toast(err.message); }
  };
}
$('#btn-add').onclick = () => agentForm({ departmentId: state.departments[0]?.id });

// Gắn phiên có sẵn
$('#btn-attach').onclick = async () => {
  openModal('<h3>Gắn phiên có sẵn</h3><p style="color:var(--muted)">Đang quét ~/.claude/projects và ~/.codex/sessions…</p>');
  let list = [];
  try { list = await api('/discover'); } catch (e) { return openModal(`<h3>Lỗi</h3><p>${esc(e.message)}</p>`); }
  openModal(`
    <h3>Gắn phiên có sẵn</h3>
    <div class="warnbox"><b>Quan sát</b>: chỉ xem phiên bạn đang chạy trong terminal, an toàn. <b>Tiếp quản</b>: văn phòng resume phiên đó và giao việc tiếp — hãy đóng phiên trong terminal trước để hai bên không ghi đè nhau.</div>
    ${list.length ? '' : '<p style="color:var(--muted)">Không tìm thấy phiên nào.</p>'}
    ${list.map((s, i) => `
      <div class="sess">
        <div class="top"><span>${s.source === 'claude' ? 'Claude Code' : 'Codex'} · ${esc(s.project)}</span><span>${ago(s.mtime)}</span></div>
        <div class="pv">${esc(s.preview || '(không có xem trước)')}</div>
        <button class="btn small" data-i="${i}" data-mode="observe">Quan sát</button>
        <button class="btn small" data-i="${i}" data-mode="control">Tiếp quản</button>
      </div>`).join('')}
    <div class="modal-actions"><button class="btn" data-close>Đóng</button></div>`);
  $('#modal-box').onclick = e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    const s = list[+b.dataset.i];
    const name = (s.preview || s.project).slice(0, 28) || 'Phiên';
    const dept = state.departments.find(d => d.id === 'ky-thuat')?.id ?? state.departments[0]?.id;
    $('#modal-box').onclick = null;
    if (b.dataset.mode === 'observe') agentForm({ name, role: 'Phiên terminal', departmentId: dept, provider: 'observer', sessionId: s.file }, false);
    else agentForm({ name, role: 'Phiên tiếp quản', departmentId: dept, provider: s.source === 'claude' ? 'claude-code' : 'codex', sessionId: s.sessionId, cwd: s.cwd || '', permissionMode: 'default' }, false);
  };
};

// Giao brief
$('#btn-brief').onclick = () => {
  const lead = state.agents.find(a => a.departmentId === 'dieu-phoi' && a.provider !== 'observer') ?? state.agents.find(a => a.provider !== 'observer');
  if (!lead) return toast('Chưa có nhân viên nào nhận việc được');
  openModal(`
    <h3>Giao brief</h3>
    <form id="brief-form">
      <div class="field"><label>Người nhận</label><select name="to">${state.agents.filter(a => a.provider !== 'observer').map(a => `<option value="${a.id}" ${a.id === lead.id ? 'selected' : ''}>${esc(a.name)} — ${esc(deptById(a.departmentId)?.name ?? '')}</option>`).join('')}</select></div>
      <div class="field brief-drop" id="brief-drop"><label>Brief</label><textarea name="prompt" style="min-height:140px" placeholder="VD: Lên 3 mẫu quảng cáo Naver Power Content cho resort ở Phú Quốc, khách Hàn 30-45 tuổi, kèm gợi ý hình ảnh. Dán ảnh tham khảo bằng Ctrl+V hoặc kéo thả tệp vào đây."></textarea>
        <div class="drop-hint">Thả tệp vào để đính kèm</div></div>
      <div class="atts" id="brief-atts" style="margin:-4px 0 10px"></div>
      <input type="file" id="brief-file" multiple hidden />
      <div class="modal-actions"><button type="button" class="btn" id="brief-attach" style="margin-right:auto">Đính kèm tệp</button><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary">Giao</button></div>
    </form>`);
  const f0 = $('#brief-form');
  const tray = makeTray({ list: $('#brief-atts'), input: f0.prompt, dropZone: $('#brief-drop'), fileInput: $('#brief-file'), button: $('#brief-attach') });
  f0.onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    if (tray.busy()) return toast('Đợi tải tệp lên xong rồi giao nhé');
    try { await api(`/agents/${f.to.value}/tasks`, 'POST', { prompt: f.prompt.value, attachments: tray.ids() }); closeModal(); openPanel(f.to.value); }
    catch (err) { toast(err.message); }
  };
};

// Sửa bố cục phòng ban
$('#btn-depts').onclick = () => {
  const list = state.departments;
  openModal(`
    <h3>Phòng ban</h3>
    <p style="color:var(--muted);margin:0 0 10px;font-size:12.5px">Sàn rộng x −18…18, z −14…14 (mét). Toạ độ là tâm khu vực.</p>
    <form id="dept-form">
      <div class="field"><label>Chọn phòng</label><select name="id">${list.map(d => opt(d.id, list[0]?.id, d.name)).join('')}${opt('__new', '', '+ Thêm phòng mới')}</select></div>
      <div id="dept-fields"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Đóng</button><button class="btn primary">Lưu</button></div>
    </form>`);
  const form = $('#dept-form');
  const fill = () => {
    const d = deptById(form.id.value) ?? { id: '', name: '', color: '#6b6f78', x: 0, z: 9, w: 6, d: 4, style: { shape: 'zone', screenTheme: 'docs' } };
    const st = d.style ?? {};
    $('#dept-fields').innerHTML = `
      ${form.id.value === '__new' ? `<div class="field"><label>Mã (không dấu)</label><input name="newId" required pattern="[a-z0-9-]+" /></div>` : ''}
      <div class="row2">
        <div class="field"><label>Tên</label><input name="name" required value="${esc(d.name)}" /></div>
        <div class="field"><label>Chữ trên sàn</label><input name="label" value="${esc(st.label ?? '')}" placeholder="${esc(d.name)}" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Kiểu khu vực</label><select name="shape">${Object.entries(SHAPES).map(([k, v]) => opt(k, st.shape ?? 'zone', v)).join('')}</select></div>
        <div class="field"><label>Màn hình hiển thị</label><select name="screenTheme">${Object.entries(THEMES).map(([k, v]) => opt(k, st.screenTheme ?? 'docs', v)).join('')}</select></div>
      </div>
      <div class="row4">
        <div class="field"><label>Tâm x</label><input name="x" type="number" step="0.1" value="${d.x}" /></div>
        <div class="field"><label>Tâm z</label><input name="z" type="number" step="0.1" value="${d.z}" /></div>
        <div class="field"><label>Rộng</label><input name="w" type="number" step="0.1" min="2" value="${d.w}" /></div>
        <div class="field"><label>Sâu</label><input name="d" type="number" step="0.1" min="2" value="${d.d}" /></div>
      </div>
      <div class="field"><label>Màu thảm</label><input name="color" type="color" value="${esc(d.color)}" /></div>`;
  };
  form.id.onchange = fill; fill();
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const id = f.id === '__new' ? f.newId : f.id;
    const prev = deptById(id)?.style ?? {};
    const body = { id, name: f.name, color: f.color, x: +f.x, z: +f.z, w: +f.w, d: +f.d, style: { ...prev, shape: f.shape, screenTheme: f.screenTheme, label: f.label || undefined, seed: prev.seed ?? Math.floor(Math.random() * 1000) } };
    try { await api('/departments', 'POST', body); toast('Đã lưu phòng ban'); closeModal(); }
    catch (err) { toast(err.message); }
  };
};

// ---------------- Token & chi phí
async function loadUsageToday() {
  try { state.usageToday = await api('/usage?range=today'); renderHud(); if (selectedId) renderPanel(); } catch { /* bỏ qua */ }
}
const PROVIDER_SHORT = { 'claude-code': 'Claude Code', 'codex': 'Codex', 'anthropic-chat': 'Claude API', 'openai-chat': 'OpenAI API', 'observer': 'Quan sát' };
let costRange = 'today';
async function renderCost(range = 'today') {
  costRange = range;
  const box = $('#cost-box'); if (!box) return;
  let d;
  try { d = await api(`/usage?range=${range}`); } catch (e) { box.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const rate = d.usdToVnd;
  const tabs = [['today', 'Hôm nay'], ['7d', '7 ngày'], ['30d', '30 ngày'], ['all', 'Tất cả']]
    .map(([k, v]) => `<button class="btn small ${k === range ? 'primary' : ''}" data-range="${k}">${v}</button>`).join('');
  const name = (id) => esc(agentById(id)?.name ?? id + ' (đã xoá)');
  const costCell = (r) => r.costUsd > 0 ? fmtUsd(r.costUsd) + fmtVnd(r.costUsd, rate) + (r.unpriced ? ' <span class="muted">+ phần chưa có giá</span>' : '') : (r.unpriced ? '<span class="muted">chưa có giá</span>' : '$0');
  const rows = d.agents.map(a => `
    <tr class="agent-row"><td><b>${name(a.agentId)}</b><div class="muted">${PROVIDER_SHORT[a.provider] ?? a.provider} · ${a.tasks} việc</div></td>
      <td>${fmtTok(a.input)}</td><td>${fmtTok(a.output)}</td><td>${fmtTok(a.cacheRead + a.cacheWrite)}</td><td class="num">${costCell(a)}</td></tr>
    ${a.models.map(m => `<tr class="model-row"><td>↳ ${esc(m.model)}</td><td>${fmtTok(m.input)}</td><td>${fmtTok(m.output)}</td><td>${fmtTok(m.cacheRead + m.cacheWrite)}</td><td class="num">${costCell(m)}</td></tr>`).join('')}`).join('');
  const t = d.total;
  const maxDay = Math.max(1, ...d.byDay.map(x => x.tokens));
  const bars = d.byDay.length > 1 ? `<div class="daybars">${d.byDay.map(x => `<div title="${x.day}: ${fmtTok(x.tokens)} token · ${fmtUsd(x.costUsd)}"><span style="height:${Math.max(3, x.tokens / maxDay * 100)}%"></span><em>${x.day.slice(8)}</em></div>`).join('')}</div>` : '';
  box.innerHTML = `
    <div class="cost-tabs">${tabs}</div>
    <div class="cost-total"><div><small>Tổng token</small><b>${fmtTok(t.input + t.output + t.cacheRead + t.cacheWrite)}</b></div>
      <div><small>Chi phí ước tính</small><b>${fmtUsd(t.costUsd)}${rate ? '<em>' + Math.round(t.costUsd * rate).toLocaleString('vi-VN') + '₫</em>' : ''}</b></div>
      <div><small>Số việc</small><b>${t.tasks}</b></div></div>
    ${bars}
    ${d.agents.length ? `<div class="cost-scroll"><table class="cost-table"><thead><tr><th>Nhân viên</th><th>Vào</th><th>Ra</th><th>Cache</th><th class="num">Chi phí</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">Chưa có việc nào trong khoảng thời gian này.</p>'}
    <p class="cost-note">• <b>Claude Code</b>: chi phí do Claude Code tự tính theo giá API. Nếu dùng gói Pro/Max (token OAuth) thì đây là <i>giá trị tương đương</i>, không phải tiền bị trừ — dùng để biết ai đang ngốn hạn mức nhiều nhất.<br>
    • <b>Codex / chat API</b>: chỉ có số token; muốn ra tiền thì điền giá vào <code>pricing.json</code> (USD / 1 triệu token). Thêm <code>usdToVnd</code> để hiện VNĐ.<br>
    • "Cache" là token đọc/ghi bộ nhớ đệm — rẻ hơn nhiều so với token vào thường.</p>`;
  box.querySelectorAll('[data-range]').forEach(b => b.onclick = () => renderCost(b.dataset.range));
}
$('#btn-cost').onclick = () => {
  openModal('<h3>Token &amp; chi phí</h3><div id="cost-box"><p class="muted">Đang tải…</p></div><div class="modal-actions"><button class="btn" data-close>Đóng</button></div>');
  renderCost('today');
};

// ---------------- Dữ liệu & WebSocket
async function loadState() {
  const s = await api('/state');
  Object.assign(state, s);
  office.setData(state.departments, state.agents);
  renderHud(); renderFeed(); if (selectedId) renderPanel();
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${TOKEN}`);
  ws.onopen = () => loadState().then(() => { $('#loading').classList.add('done'); loadUsageToday(); }).catch(e => toast(e.message));
  ws.onmessage = (m) => {
    const { type, payload } = JSON.parse(m.data);
    if (type === 'status') {
      const a = agentById(payload.agentId);
      if (a) { a.status = payload.status; office.setStatus(a.id, a.status); renderHud(); if (a.id === selectedId) renderPanel(); }
      clearTimeout(connect._t); connect._t = setTimeout(() => loadState().catch(() => {}), 400);
    } else if (type === 'event') {
      if (['task', 'result', 'error', 'permission'].includes(payload.kind)) { state.feed.push(payload); state.feed = state.feed.slice(-30); renderFeed(); }
      if (payload.kind === 'task' && payload.data?.fromAgentId) office.courier(payload.data.fromAgentId, payload.agentId);
      if (payload.agentId === selectedId) appendLog(payload);
    } else if (type === 'permission') {
      state.permissions.push(payload); if (payload.agentId === selectedId) renderPerms();
      const a = agentById(payload.agentId); toast(`${a?.name ?? payload.agentId} xin quyền dùng ${payload.tool}`);
    } else if (type === 'permission-resolved') {
      state.permissions = state.permissions.filter(p => p.id !== payload.id); renderPerms();
    } else if (type === 'usage') {
      clearTimeout(connect._u); connect._u = setTimeout(() => { loadUsageToday(); if ($('#cost-box')) renderCost(costRange); }, 800);
    } else if (type === 'changed') loadState().catch(() => {});
  };
  ws.onclose = () => { $('#hud-title').textContent = 'Mất kết nối, đang thử lại…'; setTimeout(connect, 2000); };
}

// Chờ font tiếng Việt (chữ trên sàn vẽ bằng canvas) rồi mới dựng cảnh
await Promise.all([document.fonts.load('600 64px "Be Vietnam Pro"'), document.fonts.load('400 14px "Be Vietnam Pro"')]).catch(() => {});
await office.init();
renderQuality();
window.__office = office; // tiện debug: __office.stats()
connect();
