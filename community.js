// community.js -- Module B: Community Real-time Chat (1:1 DMs)
import { requireAuth, supabase } from './auth.js';
import { getLocalPrivateKey } from './e2ee.js';
import {
  getConversationKey, encryptPayload, decryptPayload, encryptFile, decryptFile
} from './chat-crypto.js';
import {
  CLOUDINARY_CLOUD, CLOUDINARY_PRESET,
  MAX_FILE_BYTES, PAGE_SIZE, ENABLE_PRESENCE
} from './chat-config.js';

/* ====================== helpers ====================== */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PALETTE = ['avatar-blue', 'avatar-indigo', 'avatar-cyan', 'avatar-amber', 'avatar-danger'];
const colorFor = (id) => PALETTE[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const initialsOf = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sanitizeQ = (q) => q.replace(/[,()%*\\]/g, ' ').trim();
const IST_MS = 5.5 * 3600 * 1000;
const istDate = (iso) => new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function toast(text, icon) {
  const t = $('toastMsg');
  $('toastText').textContent = text;
  t.querySelector('i').className = 'fas ' + (icon || 'fa-circle-check');
  t.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* mute list (sirf is device ki preference) */
let muted = new Set();
try { muted = new Set(JSON.parse(localStorage.getItem('mgm_chat_muted') || '[]')); } catch { /* ignore */ }
const saveMuted = () => { try { localStorage.setItem('mgm_chat_muted', JSON.stringify([...muted])); } catch { /* ignore */ } };

/* ====================== state ====================== */
const S = {
  me: null,
  priv: null,                 // meri private CryptoKey (IndexedDB se)
  convs: new Map(),           // id -> conversation
  blocked: new Set(),         // jinhe maine block kiya
  online: new Set(),
  current: null,
  blobs: new Map()            // decrypted attachment cache
};
const cur = () => S.convs.get(S.current);
const otherIdOf = (row) => (row.user_a === S.me ? row.user_b : row.user_a);

function mkConv(row, other) {
  const iAmA = row.user_a === S.me;
  return {
    id: row.id, status: row.status, requestedBy: row.requested_by, other,
    lastAt: row.last_message_at,
    clearedBefore: (iAmA ? row.cleared_before_a : row.cleared_before_b) || null,
    messages: [], ids: new Set(),
    oldestLive: null, liveExhausted: false,
    archiveFiles: null, archiveIdx: 0, archiveDone: false,
    loaded: false, loading: false, unread: 0, preview: null
  };
}

async function fetchProfiles(ids) {
  if (!ids.length) return new Map();
  const { data } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,public_key').in('id', ids);
  return new Map((data || []).map((p) => [p.id, p]));
}

function upsertConv(row, profMap) {
  const ex = S.convs.get(row.id);
  if (ex) {
    ex.status = row.status; ex.requestedBy = row.requested_by; ex.lastAt = row.last_message_at;
    ex.clearedBefore = (row.user_a === S.me ? row.cleared_before_a : row.cleared_before_b) || null;
    return ex;
  }
  const oid = otherIdOf(row);
  const other = profMap.get(oid) || { id: oid, full_name: 'Unknown user', roll_no: '', public_key: null };
  const c = mkConv(row, other);
  S.convs.set(c.id, c);
  return c;
}

/* ====================== crypto glue ====================== */
async function keyFor(c) {
  if (!S.priv) throw new Error('NO_LOCAL_KEY');
  return getConversationKey(c.id, S.priv, c.other.public_key);
}

async function decryptMsg(c, m) {
  if (m._p) return m;
  try {
    m._p = await decryptPayload(await keyFor(c), m);
  } catch (e) {
    const why = e.message === 'NO_LOCAL_KEY' ? '🔒 Chat locked (is device par key nahi)'
      : e.message === 'NO_PEER_KEY' ? '🔒 Samne wale ki key available nahi'
      : '🔒 Message decrypt nahi ho paya';
    m._p = { t: 'text', text: why, _err: true };
  }
  return m;
}

async function addMessages(c, rows) {
  const fresh = rows.filter((m) => !c.ids.has(m.id));
  await Promise.all(fresh.map((m) => decryptMsg(c, m)));
  for (const m of fresh) { c.ids.add(m.id); c.messages.push(m); }
  c.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return fresh.length;
}

function previewOf(m) {
  const p = m._p || {};
  const body = p.t === 'file' && p.file ? '📎 ' + p.file.name : (p.text || '');
  return (m.sender_id === S.me ? 'You: ' : '') + body;
}

/* ====================== load data ====================== */
async function loadConversations() {
  const { data: rows, error } = await supabase.from('conversations')
    .select('*').order('last_message_at', { ascending: false });
  if (error) { toast('Chats load nahi hui: ' + error.message, 'fa-triangle-exclamation'); return; }
  const profs = await fetchProfiles([...new Set(rows.map(otherIdOf))]);
  rows.forEach((r) => upsertConv(r, profs));
}

// Chat list ke snippets ke liye recent messages ek hi query me
async function loadPreviews() {
  if (!S.priv) return;
  const { data } = await supabase.from('messages').select('*')
    .order('created_at', { ascending: false }).limit(150);
  const seen = new Set();
  for (const m of data || []) {
    if (seen.has(m.conversation_id)) continue;
    seen.add(m.conversation_id);
    const c = S.convs.get(m.conversation_id);
    if (!c) continue;
    if (c.clearedBefore && new Date(m.created_at) <= new Date(c.clearedBefore)) continue;
    await decryptMsg(c, m);
    c.preview = previewOf(m);
  }
}

async function loadInitial(c) {
  c.loading = true;
  let q = supabase.from('messages').select('*').eq('conversation_id', c.id)
    .order('created_at', { ascending: false }).limit(PAGE_SIZE);
  if (c.clearedBefore) q = q.gt('created_at', c.clearedBefore);
  const { data, error } = await q;
  if (error) { c.loading = false; throw error; }
  const rows = (data || []).reverse();
  if (rows.length) c.oldestLive = rows[0].created_at;
  c.liveExhausted = rows.length < PAGE_SIZE;
  await addMessages(c, rows);
  c.loaded = true;
  c.loading = false;
}

/* ---------- Archive: index Supabase 'chat_archives' me, files Cloudinary par ---------- */
async function loadNextArchive(c) {
  if (!c.archiveFiles) {
    let q = supabase.from('chat_archives').select('url, archive_date')
      .eq('conversation_id', c.id)
      .order('archive_date', { ascending: false })
      .order('created_at', { ascending: false });          // newest -> oldest
    if (c.clearedBefore) q = q.gte('archive_date', istDate(c.clearedBefore));
    const { data, error } = await q;
    if (error) throw error;
    c.archiveFiles = data || [];
    c.archiveIdx = 0;
  }
  if (c.archiveIdx >= c.archiveFiles.length) { c.archiveDone = true; return 0; }

  const file = c.archiveFiles[c.archiveIdx++];
  try {
    const r = await fetch(file.url);                         // browser seedha Cloudinary se padhta hai
    if (!r.ok) throw new Error('ARCHIVE_' + r.status);
    let msgs = (await r.json()).messages || [];
    if (c.clearedBefore) msgs = msgs.filter((m) => new Date(m.created_at) > new Date(c.clearedBefore));
    return await addMessages(c, msgs);                       // client-side decrypt yahin hota hai
  } catch (e) {
    c.archiveIdx--;                                          // fail hua to isi file ko dobara try karenge
    throw e;
  }
}

async function loadOlder(c) {
  if (!c || c.loading || !c.loaded || (c.liveExhausted && c.archiveDone)) return false;
  c.loading = true;
  if (S.current === c.id) renderMessages(c, 'stay');   // "Loading older..." dikhane ke liye
  let added = 0;
  try {
    if (!c.liveExhausted) {
      let q = supabase.from('messages').select('*').eq('conversation_id', c.id)
        .order('created_at', { ascending: false }).limit(PAGE_SIZE);
      if (c.oldestLive) q = q.lt('created_at', c.oldestLive);
      if (c.clearedBefore) q = q.gt('created_at', c.clearedBefore);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []).reverse();
      if (rows.length) c.oldestLive = rows[0].created_at;
      if (rows.length < PAGE_SIZE) c.liveExhausted = true;
      added = await addMessages(c, rows);
    }
    while (!added && c.liveExhausted && !c.archiveDone) added = await loadNextArchive(c);
  } catch (e) {
    console.error(e);
    toast('Purane messages load nahi hue', 'fa-triangle-exclamation');
  }
  c.loading = false;
  if (S.current === c.id) renderMessages(c, 'prepend');
  return added > 0;
}

/* ====================== rendering: lists ====================== */
function snippetFor(c, isReq) {
  if (isReq) return 'Wants to connect with you';
  if (!S.priv) return '🔒 Encrypted';
  if (c.status === 'pending') return c.preview ? esc(c.preview) : 'Request sent · waiting';
  return c.preview ? esc(c.preview) : 'Say hi 👋';
}

function chatItemEl(c, isReq) {
  const el = document.createElement('div');
  el.className = 'chat-item' + (S.current === c.id ? ' active' : '');
  el.dataset.id = c.id;
  el.dataset.name = c.other.full_name || '';
  el.dataset.sub = c.other.roll_no || '';
  const online = S.online.has(c.other.id);
  el.innerHTML = `
    <div class="chat-avatar"><div class="av ${colorFor(c.other.id)}">${esc(initialsOf(c.other.full_name))}</div>${online ? '<span class="dot-online"></span>' : ''}</div>
    <div class="chat-meta">
      <div class="row-top"><span class="name">${esc(c.other.full_name)}</span><span class="time">${c.preview || isReq ? fmtTime(c.lastAt) : ''}</span></div>
      <div class="snippet">${snippetFor(c, isReq)}</div>
      ${isReq ? `<div class="req-actions-mini">
        <button class="req-accept-mini" data-action="accept-request">Accept</button>
        <button class="req-reject-mini" data-action="reject-request">Reject</button></div>` : ''}
    </div>
    ${c.unread ? `<div class="unread-badge">${c.unread}</div>` : ''}`;
  return el;
}

function emptyNote(text) {
  const d = document.createElement('div');
  d.className = 'empty-note';
  d.textContent = text;
  return d;
}

let listTimer = null;
function renderLists() {
  const chats = [], reqs = [];
  for (const c of S.convs.values()) {
    if (c.status === 'rejected') continue;
    if (c.status === 'pending' && c.requestedBy !== S.me) reqs.push(c); else chats.push(c);
  }
  const byLast = (a, b) => new Date(b.lastAt) - new Date(a.lastAt);
  chats.sort(byLast); reqs.sort(byLast);

  $('tab-chats').replaceChildren(...(chats.length
    ? chats.map((c) => chatItemEl(c, false))
    : [emptyNote('Abhi koi chat nahi. Upar ✏️ se naya chat shuru karo.')]));
  $('tab-requests').replaceChildren(...(reqs.length
    ? reqs.map((c) => chatItemEl(c, true))
    : [emptyNote('Koi pending request nahi.')]));
  document.querySelector('.req-count').textContent = `(${reqs.length})`;
  applySearchFilter();
}
const renderListsSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderLists, 250); };

function applySearchFilter() {
  const q = $('searchInput').value.trim().toLowerCase();
  document.querySelectorAll('.chat-item').forEach((item) => {
    const hay = ((item.dataset.name || '') + ' ' + (item.dataset.sub || '')).toLowerCase();
    item.style.display = (!q || hay.includes(q)) ? 'flex' : 'none';
  });
}

/* ====================== rendering: chat window ====================== */
function renderChatWindow() {
  const c = cur();
  const hdrStatus = $('hdrStatus');
  $('hdrGroupLink').style.display = 'none';
  $('inviteBtn').style.display = 'none';

  if (!c) {
    $('hdrName').textContent = 'Select a chat';
    $('hdrAvatar').textContent = '?';
    $('hdrAvatar').className = 'av avatar-blue';
    hdrStatus.textContent = '';
    $('inputArea').style.display = 'none';
    $('requestBlock').style.display = 'none';
    $('blockedBlock').style.display = 'none';
    $('messagesArea').replaceChildren(emptyNote('Koi chat chuno ya naya chat shuru karo.'));
    return;
  }

  $('hdrName').textContent = c.other.full_name;
  $('hdrAvatar').textContent = initialsOf(c.other.full_name);
  $('hdrAvatar').className = 'av ' + colorFor(c.other.id);

  const incomingReq = c.status === 'pending' && c.requestedBy !== S.me;
  const blocked = S.blocked.has(c.other.id);

  if (c.status === 'pending' && !incomingReq) {
    hdrStatus.innerHTML = '<span class="dot"></span> Request pending';
    hdrStatus.style.color = 'var(--ink-faint)';
  } else {
    const on = S.online.has(c.other.id);
    hdrStatus.innerHTML = '<span class="dot"></span> ' + (on ? 'Online' : 'Offline');
    hdrStatus.style.color = on ? 'var(--success)' : 'var(--ink-faint)';
  }

  const bm = $('blockMenuItem');
  bm.style.display = 'flex';
  bm.innerHTML = blocked ? '<i class="fas fa-lock-open"></i> Unblock User' : '<i class="fas fa-ban"></i> Block User';
  const mm = document.querySelector('#moreMenu [data-action="mute"]');
  mm.innerHTML = muted.has(c.id)
    ? '<i class="fas fa-bell"></i> Unmute Notifications'
    : '<i class="fas fa-bell-slash"></i> Mute Notifications';

  if (blocked) {
    $('requestBlock').style.display = 'none'; $('inputArea').style.display = 'none';
    $('blockedBlock').style.display = 'flex';
    $('blockedName').textContent = c.other.full_name;
  } else if (incomingReq) {
    $('blockedBlock').style.display = 'none'; $('inputArea').style.display = 'none';
    $('requestBlock').style.display = 'flex';
    $('reqName').textContent = c.other.full_name;
  } else {
    $('requestBlock').style.display = 'none'; $('blockedBlock').style.display = 'none';
    $('inputArea').style.display = S.priv ? 'flex' : 'none';
  }
}

function fileEl(file, cacheKey) {
  const box = document.createElement('div');
  const isImg = (file.mime || '').startsWith('image/');
  if (isImg) {
    const img = document.createElement('img');
    img.className = 'f-thumb';
    img.alt = file.name;
    box.appendChild(img);
    blobUrl(cacheKey, file).then((u) => { img.src = u; img.style.cursor = 'zoom-in'; img.onclick = () => window.open(u, '_blank'); })
      .catch(() => { img.replaceWith(emptyNote('Image load nahi hui')); });
  }
  const fb = document.createElement('div');
  fb.className = 'file-bubble';
  fb.style.cursor = 'pointer';
  const icon = isImg ? 'fa-image' : (file.mime === 'application/pdf' ? 'fa-file-pdf' : 'fa-file');
  fb.innerHTML = `<div class="f-icon"><i class="fas ${icon}"></i></div>
    <div class="f-info"><div class="f-name">${esc(file.name)}</div><div class="f-size">${formatSize(file.size || 0)}</div></div>`;
  fb.onclick = async () => {
    try {
      const u = await blobUrl(cacheKey, file);
      const a = document.createElement('a'); a.href = u; a.download = file.name; a.click();
    } catch { toast('File download nahi hui', 'fa-triangle-exclamation'); }
  };
  box.appendChild(fb);
  return box;
}

function blobUrl(key, file) {
  if (!S.blobs.has(key)) {
    S.blobs.set(key, decryptFile(file).then((b) => URL.createObjectURL(b)).catch((e) => { S.blobs.delete(key); throw e; }));
  }
  return S.blobs.get(key);
}

function msgRow(m) {
  const mine = m.sender_id === S.me;
  const p = m._p || {};
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'out' : 'in');
  const wrap = document.createElement('div'); wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (p.t === 'file' && p.file) bubble.appendChild(fileEl(p.file, m.id));
  if (p.text) { const t = document.createElement('div'); t.textContent = p.text; bubble.appendChild(t); }
  const meta = document.createElement('div'); meta.className = 'meta-line';
  meta.innerHTML = fmtTime(m.created_at) + (mine ? ' <i class="fas fa-check seen"></i>' : '');
  bubble.appendChild(meta);
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  return row;
}

// mode: 'bottom' (naya msg/open), 'prepend' (purane upar add hue), 'stay'
function renderMessages(c, mode = 'bottom') {
  const area = $('messagesArea');
  const prevH = area.scrollHeight, prevTop = area.scrollTop;
  const frag = document.createDocumentFragment();

  if (c.loading && c.loaded) frag.appendChild(emptyNote('Purane messages load ho rahe hain…'));
  else if (c.liveExhausted && c.archiveDone && c.messages.length) frag.appendChild(emptyNote('— Conversation ki shuruaat —'));

  if (!c.messages.length && c.loaded && !c.loading) {
    frag.appendChild(emptyNote(c.liveExhausted && c.archiveDone ? 'Abhi koi message nahi. Pehla message bhejo 👋' : 'Purane messages ke liye upar scroll karo'));
  }

  let lastDay = '';
  for (const m of c.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div'); d.className = 'day-divider';
      d.innerHTML = `<span>${esc(dayLabel(m.created_at))}</span>`;
      frag.appendChild(d);
    }
    frag.appendChild(msgRow(m));
  }
  area.replaceChildren(frag);

  if (mode === 'bottom') area.scrollTop = area.scrollHeight;
  else if (mode === 'prepend') area.scrollTop = area.scrollHeight - prevH + prevTop;
  else area.scrollTop = prevTop;
}

// Agar messages kam hain aur scrollbar nahi bana, to scroll event nahi aayega: khud purane load karo
async function fillIfShort(c, depth = 0) {
  const area = $('messagesArea');
  if (depth > 6 || S.current !== c.id) return;
  if (area.scrollHeight > area.clientHeight + 90) return;
  if (c.liveExhausted && c.archiveDone) return;
  const got = await loadOlder(c);
  if (got) await fillIfShort(c, depth + 1);
}

/* ====================== open conversation ====================== */
function openMobilePane() {
  const chatApp = document.querySelector('.chat-app');
  const wasOpen = chatApp.classList.contains('mobile-chat-open');
  chatApp.classList.add('mobile-chat-open');
  if (!wasOpen && window.matchMedia('(max-width: 900px)').matches) {
    history.pushState({ mgmChatOpen: true }, '');
  }
}
const closeMobilePane = () => document.querySelector('.chat-app').classList.remove('mobile-chat-open');

async function openConv(id) {
  const c = S.convs.get(id);
  if (!c) return;
  S.current = id;
  c.unread = 0;
  renderLists();
  renderChatWindow();
  $('moreMenu').classList.remove('show');
  openMobilePane();

  if (!S.priv) {
    $('messagesArea').replaceChildren(emptyNote('🔒 Is device par encryption key nahi hai. Sign out karke dobara login karo aur Security Keyword daalo.'));
    return;
  }
  if (!c.loaded) {
    $('messagesArea').replaceChildren(emptyNote('Loading…'));
    try { await loadInitial(c); }
    catch (e) { console.error(e); $('messagesArea').replaceChildren(emptyNote('Messages load nahi hue.')); return; }
  }
  if (S.current !== id) return;
  renderMessages(c, 'bottom');
  fillIfShort(c);
}

/* ====================== sending ====================== */
function sendErrorMessage(e) {
  if (e?.message === 'NO_LOCAL_KEY') return 'Chat locked: dobara login karke Security Keyword daalo.';
  if (e?.message === 'NO_PEER_KEY') return 'Is user ne abhi encryption keys set nahi ki.';
  if (e?.code === '42501') return 'Message nahi bheja ja saka (request pending limit ya block).';
  return 'Message nahi gaya: ' + (e?.message || 'unknown error');
}

async function sendPayload(c, payload) {
  const { ciphertext, iv } = await encryptPayload(await keyFor(c), payload);
  const { data, error } = await supabase.from('messages')
    .insert({ conversation_id: c.id, sender_id: S.me, ciphertext, iv }).select().single();
  if (error) throw error;
  data._p = payload;                       // already plain hai, dobara decrypt nahi
  await addMessages(c, [data]);
  c.preview = previewOf(data);
  c.lastAt = data.created_at;
  renderListsSoon();
  if (S.current === c.id) renderMessages(c, 'bottom');
}

async function sendText() {
  const c = cur();
  const input = $('msgInput');
  const text = input.value.trim();
  if (!c || !text) return;
  input.value = '';
  try { await sendPayload(c, { t: 'text', text }); }
  catch (e) { input.value = text; toast(sendErrorMessage(e), 'fa-triangle-exclamation'); }
}

async function uploadToCloudinary(blob) {
  const fd = new FormData();
  fd.append('file', blob, 'enc.bin');
  fd.append('upload_preset', CLOUDINARY_PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('Cloudinary upload fail (' + r.status + ')');
  return (await r.json()).secure_url;
}

async function sendAttachment(file) {
  const c = cur();
  if (!c || !file) return;
  if (!(file.type.startsWith('image/') || file.type === 'application/pdf')) {
    toast('Sirf images aur PDF bhej sakte ho', 'fa-triangle-exclamation'); return;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast('File ' + formatSize(MAX_FILE_BYTES) + ' se badi hai', 'fa-triangle-exclamation'); return;
  }
  if (!CLOUDINARY_CLOUD || CLOUDINARY_CLOUD.startsWith('YOUR')) {
    toast('chat-config.js me Cloudinary details daalo', 'fa-triangle-exclamation'); return;
  }
  toast('Encrypt + upload ho raha hai…', 'fa-spinner');
  try {
    const enc = await encryptFile(file);
    const url = await uploadToCloudinary(enc.blob);
    await sendPayload(c, {
      t: 'file', text: '',
      file: { url, key: enc.key, iv: enc.iv, name: file.name, size: file.size, mime: file.type }
    });
    toast('Attachment bhej diya');
  } catch (e) { toast(sendErrorMessage(e), 'fa-triangle-exclamation'); }
}

/* ====================== realtime ====================== */
async function onConvChange(row, isInsert) {
  if (row.user_a !== S.me && row.user_b !== S.me) return;
  const known = S.convs.has(row.id);
  const profs = known ? new Map() : await fetchProfiles([otherIdOf(row)]);
  const c = upsertConv(row, profs);
  if (isInsert && !known && row.requested_by !== S.me) toast('Naya message request: ' + c.other.full_name, 'fa-user-plus');
  renderLists();
  if (S.current === c.id) renderChatWindow();
}

async function onNewMessage(m) {
  let c = S.convs.get(m.conversation_id);
  if (!c) {
    const { data } = await supabase.from('conversations').select('*').eq('id', m.conversation_id).maybeSingle();
    if (!data) return;
    await onConvChange(data, true);
    c = S.convs.get(m.conversation_id);
    if (!c) return;
  }
  if (c.ids.has(m.id)) return;                                   // apna hi bheja hua (echo)
  if (m.sender_id !== S.me && S.blocked.has(c.other.id)) return;
  if (c.clearedBefore && new Date(m.created_at) <= new Date(c.clearedBefore)) return;

  if (c.loaded) await addMessages(c, [m]); else await decryptMsg(c, m);
  c.preview = previewOf(m);
  c.lastAt = m.created_at;

  if (m.sender_id !== S.me) {
    if (S.current === c.id) {
      const area = $('messagesArea');
      const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 140;
      renderMessages(c, nearBottom ? 'bottom' : 'stay');
    } else {
      c.unread++;
      if (!muted.has(c.id)) toast(c.other.full_name + ': ' + (previewOf(m).slice(0, 40)), 'fa-message');
    }
  } else if (S.current === c.id) {
    renderMessages(c, 'bottom');
  }
  renderLists();
}

function subscribeRealtime() {
  supabase.channel('chat-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => onNewMessage(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new, true))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new, false))
    .subscribe();

  if (ENABLE_PRESENCE) {
    const ch = supabase.channel('portal-presence', { config: { presence: { key: S.me } } });
    ch.on('presence', { event: 'sync' }, () => {
      S.online = new Set(Object.keys(ch.presenceState()));
      renderListsSoon();
      if (S.current) renderChatWindow();
    }).subscribe(async (st) => { if (st === 'SUBSCRIBED') await ch.track({ at: Date.now() }); });
  }
}

/* ====================== actions: requests / block / clear / report ====================== */
async function respond(c, accept) {
  const { error } = await supabase.rpc('respond_request', { p_conv: c.id, p_accept: accept });
  if (error) { toast(error.message, 'fa-triangle-exclamation'); return; }
  c.status = accept ? 'accepted' : 'rejected';
  if (!accept && S.current === c.id) S.current = null;
  renderLists();
  renderChatWindow();
  toast(accept ? 'Request accepted' : 'Request declined', accept ? 'fa-circle-check' : 'fa-ban');
  if (accept) { document.querySelector('.tab-btn[data-tab="chats"]').click(); openConv(c.id); }
}

async function toggleBlock(c) {
  const id = c.other.id;
  try {
    if (S.blocked.has(id)) {
      const { error } = await supabase.from('blocks').delete().eq('blocker', S.me).eq('blocked', id);
      if (error) throw error;
      S.blocked.delete(id);
      toast(c.other.full_name + ' unblocked', 'fa-lock-open');
    } else {
      const { error } = await supabase.from('blocks').insert({ blocker: S.me, blocked: id });
      if (error) throw error;
      S.blocked.add(id);
      toast(c.other.full_name + ' blocked', 'fa-ban');
    }
    renderChatWindow();
  } catch (e) { toast(e.message, 'fa-triangle-exclamation'); }
}

async function clearChat(c) {
  if (!confirm('Is chat ke saare messages sirf tumhare liye clear ho jayenge. Contact bana rahega. Continue?')) return;
  const { error } = await supabase.rpc('clear_chat', { p_conv: c.id });
  if (error) { toast(error.message, 'fa-triangle-exclamation'); return; }
  c.clearedBefore = new Date().toISOString();
  c.messages = []; c.ids = new Set(); c.preview = null;
  c.liveExhausted = true; c.archiveDone = true;
  renderMessages(c, 'bottom');
  renderLists();
  toast('Chat cleared', 'fa-trash-can');
}

async function reportChat(c) {
  if (!confirm('Report karne par is chat ke last 5 messages (decrypted) moderators ko bheje jayenge. Continue?')) return;
  const evidence = c.messages.slice(-5).map((m) => ({
    from: m.sender_id === S.me ? 'reporter' : 'reported',
    at: m.created_at,
    text: m._p?.text || (m._p?.file ? '[file] ' + m._p.file.name : '')
  }));
  const { error } = await supabase.from('reports').insert({
    reporter: S.me, reported_user: c.other.id, conversation_id: c.id, evidence
  });
  toast(error ? 'Report submit nahi hui' : 'Report submit ho gayi. Team review karegi.', error ? 'fa-triangle-exclamation' : 'fa-flag');
}

/* ====================== new chat modal ====================== */
let searchTimer = null;
async function searchPeople(raw) {
  const list = $('ncFriendList');
  const q = sanitizeQ(raw);
  if (q.length < 2) { list.replaceChildren(emptyNote('Naam ya roll number ke kam se kam 2 letters likho')); return; }
  const { data, error } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,public_key')
    .neq('id', S.me)
    .or(`full_name.ilike.%${q}%,roll_no.ilike.%${q}%`).limit(20);
  if (error) { list.replaceChildren(emptyNote('Search fail: ' + error.message)); return; }
  if (!data.length) { list.replaceChildren(emptyNote('Koi student nahi mila')); return; }
  list.innerHTML = data.map((p) => `
    <div class="friend-suggestion-item" data-id="${esc(p.id)}">
      <div class="av ${colorFor(p.id)}">${esc(initialsOf(p.full_name))}</div>
      <div class="f-name-wrap"><strong>${esc(p.full_name)}</strong><span>${esc(p.roll_no || '')}${p.branch ? ' · ' + esc(p.branch) : ''}</span></div>
      <div class="select-check"><i class="fas fa-check"></i></div>
    </div>`).join('');
  list._results = new Map(data.map((p) => [p.id, p]));
}

async function startChatWith(profile) {
  const { data: cid, error } = await supabase.rpc('start_conversation', { p_other: profile.id });
  if (error) { toast(error.message, 'fa-triangle-exclamation'); return; }
  const { data: row } = await supabase.from('conversations').select('*').eq('id', cid).single();
  const c = upsertConv(row, new Map([[profile.id, profile]]));
  if (c.status === 'rejected') { toast('Ye request pehle decline ho chuki hai', 'fa-ban'); return; }
  $('createModal').classList.remove('show');
  const incoming = c.status === 'pending' && c.requestedBy !== S.me;
  document.querySelector(`.tab-btn[data-tab="${incoming ? 'requests' : 'chats'}"]`).click();
  renderLists();
  openConv(c.id);
  if (!incoming && c.status === 'pending' && !c.loaded) toast('Request bhej di. Accept hone tak 3 messages bhej sakte ho.', 'fa-paper-plane');
}

/* ====================== wiring ====================== */
function wireUI() {
  // tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    ['chats', 'groups', 'requests'].forEach((t) => {
      $('tab-' + t).style.display = (t === btn.dataset.tab) ? 'block' : 'none';
    });
  }));

  // list clicks (chats + requests)
  ['tab-chats', 'tab-requests'].forEach((id) => $(id).addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    const c = S.convs.get(item.dataset.id);
    if (!c) return;
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act === 'accept-request') { e.stopPropagation(); respond(c, true); return; }
    if (act === 'reject-request') { e.stopPropagation(); respond(c, false); return; }
    openConv(c.id);
  }));

  // request / blocked banners inside window
  $('requestBlock').addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    const c = cur(); if (!c) return;
    if (act === 'accept-window') respond(c, true);
    if (act === 'reject-window') respond(c, false);
  });
  $('blockedBlock').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="unblock"]') && cur()) toggleBlock(cur());
  });

  // more menu
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); $('moreMenu').classList.toggle('show'); });
  document.addEventListener('click', () => $('moreMenu').classList.remove('show'));
  $('moreMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-action]');
    const c = cur();
    if (!btn || !c) return;
    const act = btn.dataset.action;
    if (act === 'mute') {
      if (muted.has(c.id)) muted.delete(c.id); else muted.add(c.id);
      saveMuted(); renderChatWindow();
      toast(muted.has(c.id) ? 'Notifications muted' : 'Notifications unmuted');
    }
    if (act === 'block') toggleBlock(c);
    if (act === 'report') reportChat(c);
    if (act === 'clear') clearChat(c);
    $('moreMenu').classList.remove('show');
  });

  // composer
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
  document.querySelector('.send-btn').addEventListener('click', sendText);
  $('fileInput').addEventListener('change', function () { const f = this.files[0]; this.value = ''; sendAttachment(f); });

  // infinite scroll up -> live table, phir Cloudinary archive
  $('messagesArea').addEventListener('scroll', () => {
    const c = cur();
    if (c && $('messagesArea').scrollTop < 80) loadOlder(c);
  });

  // mobile back
  $('backToListBtn').addEventListener('click', () => {
    if (history.state && history.state.mgmChatOpen) history.back(); else closeMobilePane();
  });
  window.addEventListener('popstate', closeMobilePane);

  // search in list
  $('searchInput').addEventListener('input', applySearchFilter);

  // new chat modal
  $('newChatBtn').addEventListener('click', () => {
    $('ncSearch').value = '';
    $('ncFriendList').replaceChildren(emptyNote('Naam ya roll number ke kam se kam 2 letters likho'));
    $('createModal').classList.add('show');
    setTimeout(() => $('ncSearch').focus(), 50);
  });
  $('closeCreateModal').addEventListener('click', () => $('createModal').classList.remove('show'));
  $('createModal').addEventListener('click', (e) => { if (e.target === $('createModal')) $('createModal').classList.remove('show'); });
  $('ncSearch').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchPeople(this.value), 250);
  });
  $('ncFriendList').addEventListener('click', (e) => {
    const item = e.target.closest('.friend-suggestion-item');
    const p = item && $('ncFriendList')._results?.get(item.dataset.id);
    if (p) startChatWith(p);
  });
}

/* ====================== init ====================== */
async function init(userId) {
  S.me = userId;
  wireUI();
  try { S.priv = await getLocalPrivateKey(S.me); } catch { S.priv = null; }

  const { data: bl } = await supabase.from('blocks').select('blocked').eq('blocker', S.me);
  S.blocked = new Set((bl || []).map((b) => b.blocked));

  await loadConversations();
  renderLists();
  renderChatWindow();
  subscribeRealtime();
  if (!S.priv) toast('Chat locked: is device par encryption key nahi hai', 'fa-lock');
  loadPreviews().then(renderLists).catch(() => {});
}

const session = await requireAuth();
if (session) init(session.user.id);
