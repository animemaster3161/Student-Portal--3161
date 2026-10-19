// community.js -- Module B: Community Real-time Chat (1:1 DMs)
import { requireAuth, supabase, unlockWithKeyword } from './auth.js';
import { getLocalPrivateKey } from './e2ee.js';
import {
  getConversationKey, encryptPayload, decryptPayload, encryptFile, decryptFile, fromB64, toB64
} from './chat-crypto.js';
import {
  CLOUDINARY_CLOUD, CLOUDINARY_PRESET,
  MAX_FILE_BYTES, PAGE_SIZE, ENABLE_PRESENCE,
  CHAT_ARCHIVE_BATCH_SIZE, CHAT_ARCHIVE_KEEP_RECENT, CHAT_ARCHIVE_AGE_MS
} from './chat-config.js';

/* ====================== helpers ====================== */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isTrustedCloudinaryUrl(value, resourceType) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' &&
      url.pathname.startsWith(`/${CLOUDINARY_CLOUD}/${resourceType}/upload/`) &&
      !url.username && !url.password;
  } catch { return false; }
}

const PALETTE = ['avatar-blue', 'avatar-indigo', 'avatar-cyan', 'avatar-amber', 'avatar-danger'];
const archivingConversations = new Set();
const pendingArchiveChecks = new Set();
const archiveWarnings = new Set();
const colorFor = (id) => PALETTE[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const initialsOf = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sanitizeQ = (q) => q.replace(/[,()%*\\]/g, ' ').trim();
const IST_MS = 5.5 * 3600 * 1000;
let pendingResourceShare = '';
try {
  const sharedUrl = new URL(new URLSearchParams(location.search).get('share') || '');
  if (sharedUrl.origin === location.origin && sharedUrl.pathname.endsWith('/elibrary.html') && sharedUrl.searchParams.has('resource')) {
    pendingResourceShare = `Shared notes: ${sharedUrl.href}`;
  }
} catch { /* no valid shared resource link */ }
const istDate = (iso) => new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);

function appendTextWithLinks(container, text) {
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[0];
    const trailing = raw.match(/[),.!?;:]+$/)?.[0] || '';
    const value = trailing ? raw.slice(0, -trailing.length) : raw;
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
      const link = document.createElement('a');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = value;
      container.append(link, document.createTextNode(trailing));
    } catch { container.append(document.createTextNode(raw)); }
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

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
  replyTarget: null,
  blobs: new Map(),           // decrypted attachment cache
  attachmentDraft: [],        // selected files waiting for explicit Send
  attachmentDraftConversationId: null,
  readReceiptsSent: new Set(),
  attachmentSending: false,
  receiptSetupWarned: false
};
const cur = () => S.convs.get(S.current);
const otherIdOf = (row) => (row.user_a === S.me ? row.user_b : row.user_a);

function mkConv(row, other, members = []) {
  const iAmA = row.user_a === S.me;
  return {
    id: row.id, isGroup: Boolean(row.is_group), groupName: row.group_name || '',
    members, myJoinedAt: members.find((member) => member.id === S.me)?.joined_at || null,
    groupKeyVersion: Number(row.group_key_version) || 1,
    groupKeys: new Map(), groupKeyRaws: new Map(), groupKeyPromises: new Map(),
    status: row.status, requestedBy: row.requested_by, other,
    lastAt: row.last_message_at,
    clearedBefore: (iAmA ? row.cleared_before_a : row.cleared_before_b) || null,
    messages: [], ids: new Set(), pendingUploads: [],
    oldestLive: null, liveExhausted: false,
    archiveFiles: null, archiveIdx: 0, archiveDone: false,
    loaded: false, loading: false, unread: 0, preview: null
  };
}

async function fetchProfiles(ids) {
  if (!ids.length) return new Map();
  const { data } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,semester,bio,public_key').in('id', ids);
  return new Map((data || []).map((p) => [p.id, p]));
}

function upsertConv(row, profMap, members = []) {
  const ex = S.convs.get(row.id);
  if (ex) {
    ex.status = row.status; ex.requestedBy = row.requested_by; ex.lastAt = row.last_message_at;
    ex.isGroup = Boolean(row.is_group); ex.groupName = row.group_name || ex.groupName || '';
    const nextVersion = Number(row.group_key_version) || 1;
    if (ex.isGroup && ex.groupKeyVersion !== nextVersion) {
      ex.groupKeyVersion = nextVersion;
      ex.groupKey = ex.groupKeys.get(nextVersion) || null;
      ex.groupKeyRaw = ex.groupKeyRaws.get(nextVersion) || null;
    }
    if (members.length || ex.isGroup) {
      ex.members = members;
      ex.myJoinedAt = members.find((member) => member.id === S.me)?.joined_at || null;
    }
    ex.clearedBefore = (row.user_a === S.me ? row.cleared_before_a : row.cleared_before_b) || null;
    return ex;
  }
  const oid = row.is_group ? row.id : otherIdOf(row);
  const other = row.is_group
    ? { id: row.id, full_name: row.group_name || 'Group chat', roll_no: '', public_key: null }
    : profMap.get(oid) || { id: oid, full_name: 'Unknown user', roll_no: '', public_key: null };
  const c = mkConv(row, other, members);
  S.convs.set(c.id, c);
  return c;
}

/* ====================== unlock chat (Security Keyword) ====================== */
function openUnlock() {
  ensureUnlockUI();
  $('unlockErr').style.display = 'none';
  $('unlockInput').value = '';
  $('unlockModal').classList.add('show');
  setTimeout(() => $('unlockInput').focus(), 50);
}

function ensureUnlockUI() {
  if ($('unlockModal')) return;

  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'unlockModal';
  ov.innerHTML = `
    <div class="modal-box">
      <h3><span><i class="fas fa-lock" style="cursor:default;color:var(--blue);margin-right:8px"></i>Unlock chat</span>
        <i class="fas fa-xmark" id="unlockClose"></i></h3>
      <p class="modal-subtext" style="margin:-6px 0 14px">
        No encryption key was found on this device. Enter your Security Keyword. This device stays unlocked until you sign out; each device asks for the keyword once after sign-in.</p>
      <input type="password" class="modal-input" id="unlockInput" placeholder="Security Keyword" autocomplete="off" name="security-keyword">
      <a href="change_keyword.html" style="display:block;text-align:center;margin-top:10px;color:var(--blue);font-size:12px;text-decoration:none">
        Forgot keyword? Recovery options</a>
      <p id="unlockErr" style="display:none;color:var(--danger);font-size:12px;margin-top:8px"></p>
      <button class="req-btn btn-accept" id="unlockBtn" style="width:100%;justify-content:center;margin-top:14px">
        <i class="fas fa-unlock"></i> Unlock</button>
    </div>`;
  document.body.appendChild(ov);

  $('unlockClose').addEventListener('click', () => ov.classList.remove('show'));
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('show'); });
  $('unlockBtn').addEventListener('click', doUnlock);
  $('unlockInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
}

// Chat window ke neeche input ki jagah dikhne wali "Chat locked" bar
function ensureLockBlock() {
  if ($('lockBlock')) return;
  const b = document.createElement('div');
  b.className = 'request-block';
  b.id = 'lockBlock';
  b.style.display = 'none';
  b.innerHTML = `
    <p><i class="fas fa-lock" style="color:var(--blue);margin-right:6px;"></i>Chat locked. Use your Security Keyword to unlock it and read or send messages.</p>
    <div class="request-buttons">
      <button class="req-btn btn-accept" id="lockBlockBtn"><i class="fas fa-unlock"></i> Unlock</button>
    </div>`;
  $('blockedBlock').after(b);
  $('lockBlockBtn').addEventListener('click', openUnlock);
}

function lockedNote() {
  const d = document.createElement('div');
  d.className = 'empty-note';
  d.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'req-btn btn-accept';
  btn.style.cssText = 'margin:12px auto 0;display:inline-flex;align-items:center;gap:8px;';
  btn.innerHTML = '<i class="fas fa-unlock"></i> Unlock with keyword';
  btn.addEventListener('click', openUnlock);
  d.appendChild(btn);
  return d;
}

async function doUnlock() {
  const kw = $('unlockInput').value;
  const err = $('unlockErr'), btn = $('unlockBtn');
  if (!kw.trim()) { err.textContent = 'Enter your keyword.'; err.style.display = 'block'; return; }

  btn.disabled = true; err.style.display = 'none';
  try {
    S.priv = await unlockWithKeyword(kw);
  } catch (e) {
    err.textContent = e.message === 'WRONG_KEYWORD' ? 'Incorrect Security Keyword. Please try again.'
      : e.message === 'NO_BACKUP' ? 'No key backup was found for this account.'
      : e.message === 'INVALID_RECOVERY_FILE' ? 'That file is not a valid MGM chat Recovery Codes file.'
      : 'Unable to unlock: ' + (e.message || 'Unknown error');
    err.style.display = 'block';
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  $('unlockModal').classList.remove('show');
  toast('Chat unlocked', 'fa-lock-open');

  // Jo messages "locked" dikha rahe the unhe dobara decrypt karo
  for (const c of S.convs.values()) {
    for (const m of c.messages) if (m._p?._err) delete m._p;
    await Promise.all(c.messages.map((m) => decryptMsg(c, m)));
  }
  try { await loadPreviews(); } catch { /* ignore */ }
  renderLists();
  const c = cur();
  if (c) await openConv(c.id); else renderChatWindow();
}

/* ====================== crypto glue ====================== */
async function keyFor(c, requestedVersion = c.groupKeyVersion || 1) {
  if (!S.priv) throw new Error('NO_LOCAL_KEY');
  if (c.isGroup) {
    const version = Number(requestedVersion) || 1;
    c.groupKeys ||= new Map(); c.groupKeyRaws ||= new Map(); c.groupKeyPromises ||= new Map();
    if (c.groupKeys.has(version)) return c.groupKeys.get(version);
    if (!c.groupKeyPromises.has(version)) {
      const promise = (async () => {
        const { data: envelope, error } = await supabase.from('group_key_envelopes')
          .select('sender_id,ciphertext,iv,key_version').eq('conversation_id', c.id)
          .eq('user_id', S.me).eq('key_version', version).maybeSingle();
        if (error) throw error;
        if (!envelope) throw new Error('GROUP_KEY_MISSING');
        const { data: sender, error: profileError } = await supabase.from('profiles')
          .select('public_key').eq('id', envelope.sender_id).single();
        if (profileError || !sender?.public_key) throw new Error('GROUP_KEY_SENDER_MISSING');
        const wrappingKey = await getConversationKey(`${c.id}:group`, S.priv, sender.public_key);
        const payload = await decryptPayload(wrappingKey, envelope);
        if (payload.t !== 'group-key' || !payload.key) throw new Error('GROUP_KEY_INVALID');
        const raw = fromB64(payload.key);
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        c.groupKeyRaws.set(version, raw);
        c.groupKeys.set(version, key);
        if (version === c.groupKeyVersion) { c.groupKeyRaw = raw; c.groupKey = key; }
        return key;
      })().catch((error) => { c.groupKeyPromises.delete(version); throw error; });
      c.groupKeyPromises.set(version, promise);
    }
    return c.groupKeyPromises.get(version);
  }
  return getConversationKey(c.id, S.priv, c.other.public_key);
}

async function decryptMsg(c, m) {
  if (m._p) return m;
  try {
    m._p = await decryptPayload(await keyFor(c, m.group_key_version || 1), m);
  } catch (e) {
    const why = e.message === 'NO_LOCAL_KEY' ? 'Chat locked (unlock to continue)'
      : e.message === 'NO_PEER_KEY' ? "The other user's encryption key is unavailable"
      : 'Unable to decrypt this message';
    m._p = { t: 'unavailable', _err: true };
  }
  return m;
}

function warnReceiptSetup(error) {
  console.error('Message receipt setup failed:', error?.message || error);
  if (S.receiptSetupWarned) return;
  S.receiptSetupWarned = true;
  toast('Run the latest schema_message_receipts.sql in the Supabase SQL Editor to enable message receipts.', 'fa-triangle-exclamation');
}

async function fetchReceiptRows(messageIds) {
  if (!messageIds?.length) return [];
  // Read the RLS-protected table directly first. The sender select policy allows
  // only receipts for their own messages; RPC is a fallback for older PostgREST caches.
  const { data, error } = await supabase.from('message_receipts')
    .select('message_id,delivered_at,read_at').in('message_id', messageIds);
  if (!error && data?.length) return data;

  const { data: rpcData, error: rpcError } = await supabase.rpc('get_message_receipts', {
    p_message_ids: messageIds
  });
  if (!rpcError && rpcData?.length) return rpcData;
  if (error && rpcError) throw rpcError;
  return data || rpcData || [];
}

async function addMessages(c, rows) {
  const joinedAt = c.isGroup && c.myJoinedAt ? new Date(c.myJoinedAt).getTime() : null;
  const fresh = rows.filter((m) => !c.ids.has(m.id)
    && (joinedAt === null || new Date(m.created_at).getTime() >= joinedAt));
  // Reserve IDs before any awaits so a local insert and its realtime echo
  // cannot race and render the same attachment twice.
  fresh.forEach((m) => c.ids.add(m.id));
  try {
  await Promise.all(fresh.map((m) => decryptMsg(c, m)));
  if (fresh.length) {
    const ownIds = fresh.filter((m) => m.sender_id === S.me && !m.archived).map((m) => m.id);
    if (ownIds.length) {
      let receiptRows = [];
      try { receiptRows = await fetchReceiptRows(ownIds); }
      catch (receiptError) { warnReceiptSetup(receiptError); }
      const receiptMap = new Map();
      for (const receipt of receiptRows || []) {
        const status = receipt.read_at ? 'read' : 'delivered';
        if (status === 'read' || !receiptMap.has(receipt.message_id)) receiptMap.set(receipt.message_id, status);
      }
      for (const m of fresh) if (ownIds.includes(m.id)) m.receipt = receiptMap.get(m.id) || 'sent';
    }
    const { data, error } = await supabase.from('message_reactions')
      .select('message_id,user_id,ciphertext,iv').in('message_id', fresh.map((m) => m.id));
    if (error) console.error('Message reactions load failed:', error.message);
    const grouped = new Map();
    for (const ciph of data || []) {
      try {
        const parent = fresh.find((message) => message.id === ciph.message_id);
        const decoded = await decryptPayload(await keyFor(c, parent?.group_key_version || 1), ciph);
        const r = { ...ciph, emoji: decoded.emoji };
        if (!grouped.has(r.message_id)) grouped.set(r.message_id, []);
        grouped.get(r.message_id).push(r);
      } catch (e) { console.error('Reaction decrypt failed:', e.message); }
    }
    for (const m of fresh) m.reactions = grouped.get(m.id) || [];
  }
  for (const m of fresh) c.messages.push(m);
  c.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return fresh.length;
  } catch (e) {
    fresh.forEach((m) => c.ids.delete(m.id));
    throw e;
  }
}

async function recordReceived(c, messages, readNow = false) {
  if (!c || !S.me || document.visibilityState !== 'visible') return;
  const ids = (messages || []).filter((m) => m && m.sender_id !== S.me && !m.archived && !m.deleted_at
    && (!readNow || !S.readReceiptsSent.has(m.id))).map((m) => m.id);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { error } = await supabase.rpc('mark_messages_received', {
      p_message_ids: batch, p_read: readNow
    });
    if (error) warnReceiptSetup(error);
    else if (readNow) batch.forEach((id) => S.readReceiptsSent.add(id));
  }
}

function updateReceiptTicksInDom(message) {
  if (S.current !== message.conversation_id) return;
  const rows = $('messagesArea').querySelectorAll('.msg-row[data-message-id]');
  const row = [...rows].find((item) => item.dataset.messageId === message.id);
  const ticks = row?.querySelector('.meta-line .receipt-ticks');
  if (!ticks) return;

  const status = message.receipt || 'sent';
  ticks.className = 'receipt-ticks ' + (status === 'sent' ? 'tick-sent' : status === 'read' ? 'tick-read' : 'tick-delivered');
  ticks.replaceChildren();
  const checkCount = status === 'sent' ? 1 : 2;
  for (let i = 0; i < checkCount; i++) {
    const check = document.createElement('span');
    check.className = 'receipt-check';
    check.textContent = '\u2713';
    ticks.appendChild(check);
  }
  ticks.title = status === 'read' ? 'Seen' : status === 'delivered' ? 'Delivered' : 'Sent';
  ticks.setAttribute('aria-label', ticks.title);
}

async function refreshOutgoingReceipts(c) {
  if (!c || !S.me || document.visibilityState !== 'visible') return;
  const outgoing = c.messages.filter((m) => m.sender_id === S.me && !m.archived);
  const ids = outgoing.map((m) => m.id);
  if (!ids.length) return;
  let data;
  try { data = await fetchReceiptRows(ids); }
  catch (error) { warnReceiptSetup(error); return; }
  const statuses = new Map();
  for (const receipt of data || []) {
    const status = receipt.read_at ? 'read' : 'delivered';
    if (status === 'read' || !statuses.has(receipt.message_id)) statuses.set(receipt.message_id, status);
  }
  for (const m of outgoing) {
    const next = statuses.get(m.id) || 'sent';
    if (m.receipt !== next) {
      m.receipt = next;
      updateReceiptTicksInDom(m);
    }
  }
}

function onReceiptChange(payload) {
  const receipt = payload.new?.message_id ? payload.new : payload.old;
  if (!receipt?.message_id) return;
  for (const c of S.convs.values()) {
    const m = c.messages.find((item) => item.id === receipt.message_id);
    if (!m || m.sender_id !== S.me) continue;
    const status = receipt.read_at ? 'read' : 'delivered';
    if (status === 'read' || m.receipt !== 'read') {
      m.receipt = status;
      updateReceiptTicksInDom(m);
    }
    break;
  }
}

function previewOf(m) {
  const senderPrefix = m.sender_id === S.me ? 'You: ' : '';
  if (m.deleted_at || m._p?.t === 'deleted') return 'This message was deleted';
  if (m._p?._err) return senderPrefix + 'Message unavailable on this device';
  const p = m._p || {};
  const body = p.t === 'file' && p.file ? 'Attachment: ' + p.file.name : (p.text || '');
  return senderPrefix + body;
}

/* ====================== load data ====================== */
async function loadConversations() {
  const { data: rows, error } = await supabase.from('conversations')
    .select('*').order('last_message_at', { ascending: false });
  if (error) { toast('Unable to load chats: ' + error.message, 'fa-triangle-exclamation'); return; }
  const directIds = rows.filter((r) => !r.is_group).map(otherIdOf);
  const groupIds = rows.filter((r) => r.is_group).map((r) => r.id);
  let memberRows = [];
  if (groupIds.length) {
    const result = await supabase.from('group_members').select('conversation_id,user_id,role,joined_at').in('conversation_id', groupIds);
    if (result.error) console.error('Group members load failed:', result.error.message);
    memberRows = result.data || [];
  }
  const allProfileIds = [...new Set([...directIds, ...memberRows.map((m) => m.user_id)])];
  const profs = await fetchProfiles(allProfileIds);
  const byGroup = new Map();
  for (const member of memberRows) {
    if (!byGroup.has(member.conversation_id)) byGroup.set(member.conversation_id, []);
    byGroup.get(member.conversation_id).push({
      ...(profs.get(member.user_id) || { id: member.user_id, full_name: 'Unknown member' }),
      role: member.role, joined_at: member.joined_at
    });
  }
  rows.forEach((r) => upsertConv(r, profs, byGroup.get(r.id) || []));
}

// Chat list ke snippets ke liye recent messages ek hi query me
async function loadPreviews() {
  if (!S.priv) return;
  const { data } = await supabase.from('messages').select('*')
    .order('created_at', { ascending: false }).limit(150);
  const seen = new Set();
  for (const m of data || []) {
    const c = S.convs.get(m.conversation_id);
    if (!c) continue;
    if (c.isGroup && c.myJoinedAt && new Date(m.created_at) < new Date(c.myJoinedAt)) continue;
    if (seen.has(m.conversation_id)) continue;
    seen.add(m.conversation_id);
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
  if (c.isGroup && c.myJoinedAt) q = q.gte('created_at', c.myJoinedAt);
  const { data, error } = await q;
  if (error) { c.loading = false; throw error; }
  const rows = (data || []).reverse();
  if (rows.length) c.oldestLive = rows[0].created_at;
  c.liveExhausted = rows.length < PAGE_SIZE;
  await addMessages(c, rows);
  c.loaded = true;
  c.loading = false;
  void archiveOverflow(c);
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
    if (!isTrustedCloudinaryUrl(file.url, 'raw')) throw new Error('INVALID_ARCHIVE_URL');
    const r = await fetch(file.url);                         // browser seedha Cloudinary se padhta hai
    if (!r.ok) throw new Error('ARCHIVE_' + r.status);
    let msgs = (await r.json()).messages || [];
    if (c.clearedBefore) msgs = msgs.filter((m) => new Date(m.created_at) > new Date(c.clearedBefore));
    msgs.forEach((m) => { m.archived = true; });
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
      if (c.isGroup && c.myJoinedAt) q = q.gte('created_at', c.myJoinedAt);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []).reverse();
      if (rows.length) c.oldestLive = rows[0].created_at;
      if (rows.length < PAGE_SIZE) c.liveExhausted = true;
      added = await addMessages(c, rows);
    }
    if (c.liveExhausted && !c.archiveDone) {
      let archiveAdded = 0;
      while (!archiveAdded && !c.archiveDone) archiveAdded = await loadNextArchive(c);
      added += archiveAdded;
    }
  } catch (e) {
    console.error(e);
    toast('Unable to load older messages.', 'fa-triangle-exclamation');
  }
  c.loading = false;
  if (S.current === c.id) renderMessages(c, 'prepend');
  return added > 0;
}

/* ====================== rendering: lists ====================== */
function snippetFor(c, isReq) {
  if (isReq) return 'Wants to connect with you';
  if (!S.priv) return '';
  if (c.status === 'pending') return c.preview ? esc(c.preview) : 'Request sent - waiting';
  return c.preview ? esc(c.preview) : 'Say hi';
}

function chatItemEl(c, isReq) {
  const el = document.createElement('div');
  el.className = 'chat-item' + (S.current === c.id ? ' active' : '');
  el.dataset.id = c.id;
  const title = c.isGroup ? c.groupName : c.other.full_name;
  const subtitle = c.isGroup ? `${c.members.length} members` : c.other.roll_no || '';
  el.dataset.name = title || '';
  el.dataset.sub = subtitle;
  if (c.isGroup) {
    el.innerHTML = `
      <div class="chat-avatar"><div class="av ${colorFor(c.id)}"><i class="fas fa-users"></i></div></div>
      <div class="chat-meta"><div class="row-top"><span class="name">${esc(title)}</span><span class="time">${c.preview ? fmtTime(c.lastAt) : ''}</span></div>
      <div class="snippet">${!S.priv ? '' : (c.preview ? esc(c.preview) : esc(subtitle))}</div></div>
      ${c.unread ? `<div class="unread-badge">${c.unread}</div>` : ''}`;
    return el;
  }
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
  const chats = [], reqs = [], groups = [];
  for (const c of S.convs.values()) {
    if (c.isGroup) { groups.push(c); continue; }
    if (c.status === 'rejected') continue;
    if (c.status === 'pending' && c.requestedBy !== S.me) reqs.push(c); else chats.push(c);
  }
  const byLast = (a, b) => new Date(b.lastAt) - new Date(a.lastAt);
  chats.sort(byLast); reqs.sort(byLast);

  $('tab-chats').replaceChildren(...(chats.length
    ? chats.map((c) => chatItemEl(c, false))
    : [emptyNote('No chats yet. Start a new chat using the button above.')]));
  $('tab-requests').replaceChildren(...(reqs.length
    ? reqs.map((c) => chatItemEl(c, true))
    : [emptyNote('No pending requests.')]));
  $('tab-groups').replaceChildren(
    $('groupCreateButton'),
    ...(groups.length ? groups.sort(byLast).map((c) => chatItemEl(c, false)) : [emptyNote('No groups yet. Create a group to get started.')])
  );
  document.querySelector('.req-count').textContent = `(${reqs.length})`;
  applySearchFilter();
}
const renderListsSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderLists, 250); };

function applySearchFilter() {
  const q = $('searchInput').value.trim().toLowerCase();
  document.querySelectorAll('.chat-item').forEach((item) => {
    // Filter only the chat title and member identifier; previews and message
    // payload fields never participate in list search.
    const hay = ((item.dataset.name || '') + ' ' + (item.dataset.sub || '')).toLowerCase();
    item.style.display = (!q || hay.includes(q)) ? 'flex' : 'none';
  });
}

/* ====================== rendering: chat window ====================== */
function renderChatWindow() {
  const c = cur();
  const hdrStatus = $('hdrStatus');
  $('hdrGroupLink').style.display = 'none';
  $('viewProfileBtn').style.display = 'none';
  $('profileMenuItem').style.display = 'none';
  $('inviteBtn').style.display = 'none';
  ensureLockBlock();
  $('lockBlock').style.display = 'none';

  if (!c) {
    $('hdrName').textContent = 'Select a chat';
    $('hdrAvatar').textContent = '?';
    $('hdrAvatar').className = 'av avatar-blue';
    hdrStatus.textContent = '';
    $('inputArea').style.display = 'none';
    renderReplyComposer(null);
    $('requestBlock').style.display = 'none';
    $('blockedBlock').style.display = 'none';
    $('messagesArea').replaceChildren(emptyNote('Select a chat or start a new one.'));
    return;
  }

  const conversationTitle = c.isGroup ? c.groupName : c.other.full_name;
  $('hdrName').textContent = conversationTitle;
  $('hdrAvatar').textContent = c.isGroup ? '' : initialsOf(c.other.full_name);
  $('hdrAvatar').className = 'av ' + colorFor(c.isGroup ? c.id : c.other.id);
  $('hdrAvatar').innerHTML = c.isGroup ? '<i class="fas fa-users"></i>' : esc(initialsOf(c.other.full_name));

  const incomingReq = !c.isGroup && c.status === 'pending' && c.requestedBy !== S.me;
  const blocked = !c.isGroup && S.blocked.has(c.other.id);
  if (c.isGroup) {
    $('hdrGroupLink').style.display = 'inline';
    $('hdrGroupLink').textContent = 'Group info';
  } else $('viewProfileBtn').style.display = 'inline-flex';

  if (c.isGroup) {
    hdrStatus.textContent = `Group - ${c.members.length} members`;
    hdrStatus.style.color = 'var(--ink-faint)';
  } else if (c.status === 'pending' && !incomingReq) {
    hdrStatus.innerHTML = '<span class="dot"></span> Request pending';
    hdrStatus.style.color = 'var(--ink-faint)';
  } else {
    const on = S.online.has(c.other.id);
    hdrStatus.innerHTML = '<span class="dot"></span> ' + (on ? 'Online' : 'Offline');
    hdrStatus.style.color = on ? 'var(--success)' : 'var(--ink-faint)';
  }

  const bm = $('blockMenuItem');
  bm.style.display = c.isGroup ? 'none' : 'flex';
  $('profileMenuItem').style.display = c.isGroup ? 'none' : 'flex';
  bm.innerHTML = blocked ? '<i class="fas fa-lock-open"></i> Unblock User' : '<i class="fas fa-ban"></i> Block User';
  const mm = document.querySelector('#moreMenu [data-action="mute"]');
  mm.innerHTML = muted.has(c.id)
    ? '<i class="fas fa-bell"></i> Unmute Notifications'
    : '<i class="fas fa-bell-slash"></i> Mute Notifications';
  document.querySelectorAll('#moreMenu [data-action="report"], #moreMenu [data-action="clear"]').forEach((item) => {
    item.style.display = c.isGroup ? 'none' : 'flex';
  });

  if (blocked) {
    clearReplyTarget();
    $('requestBlock').style.display = 'none'; $('inputArea').style.display = 'none';
    $('blockedBlock').style.display = 'flex';
    $('blockedName').textContent = c.other.full_name;
  } else if (incomingReq) {
    clearReplyTarget();
    $('blockedBlock').style.display = 'none'; $('inputArea').style.display = 'none';
    $('requestBlock').style.display = 'flex';
    $('reqName').textContent = c.other.full_name;
  } else {
    $('requestBlock').style.display = 'none'; $('blockedBlock').style.display = 'none';
    $('inputArea').style.display = S.priv ? 'flex' : 'none';
    $('lockBlock').style.display = S.priv ? 'none' : 'flex';
    renderReplyComposer(c);
  }
}

let contactProfileRequest = 0;
async function openContactProfile(c = cur()) {
  if (!c || c.isGroup) return;
  const requestId = ++contactProfileRequest;
  const profileId = c.other.id;
  const fallback = c.other || {};
  $('contactProfileName').textContent = fallback.full_name || 'Student profile';
  $('contactProfileAvatar').className = 'av ' + colorFor(profileId);
  $('contactProfileAvatar').textContent = initialsOf(fallback.full_name);
  $('contactProfileRoll').textContent = fallback.roll_no ? `Roll no. ${fallback.roll_no}` : 'Student';
  $('contactProfileBranch').textContent = 'Loading...';
  $('contactProfileYear').textContent = 'Loading...';
  $('contactProfileSemester').textContent = 'Loading...';
  $('contactProfileBio').textContent = 'Loading...';
  $('contactProfileBioSection').style.display = 'block';
  $('contactProfileModal').classList.add('show');

  try {
    const { data, error } = await supabase.from('profiles')
      .select('id,full_name,roll_no,branch,year,semester,bio')
      .eq('id', profileId).maybeSingle();
    if (error) throw error;
    if (requestId !== contactProfileRequest) return;
    const profile = { ...fallback, ...(data || {}) };
    c.other = { ...c.other, ...profile };
    $('contactProfileName').textContent = profile.full_name || 'Student profile';
    $('contactProfileAvatar').textContent = initialsOf(profile.full_name);
    $('contactProfileRoll').textContent = profile.roll_no ? `Roll no. ${profile.roll_no}` : 'Roll number not shared';
    $('contactProfileBranch').textContent = profile.branch || 'Not shared';
    $('contactProfileYear').textContent = profile.year ? `Year ${profile.year}` : 'Not shared';
    $('contactProfileSemester').textContent = profile.semester ? `Semester ${profile.semester}` : 'Not shared';
    const bio = String(profile.bio || '').trim();
    $('contactProfileBioSection').style.display = bio ? 'block' : 'none';
    $('contactProfileBio').textContent = bio;
  } catch (error) {
    if (requestId !== contactProfileRequest) return;
    $('contactProfileBranch').textContent = fallback.branch || 'Not shared';
    $('contactProfileYear').textContent = fallback.year ? `Year ${fallback.year}` : 'Not shared';
    $('contactProfileSemester').textContent = fallback.semester ? `Semester ${fallback.semester}` : 'Not shared';
    const bio = String(fallback.bio || '').trim();
    $('contactProfileBioSection').style.display = bio ? 'block' : 'none';
    $('contactProfileBio').textContent = bio;
    console.error('Contact profile load failed:', error.message);
    toast('Some profile details could not be loaded.', 'fa-triangle-exclamation');
  }
}

function closeAttachmentViewer(fromHistory = false) {
  const overlay = $('attachmentViewer');
  if (!overlay) return;
  if (!fromHistory && history.state?.mgmAttachmentViewer) {
    history.back();
    return;
  }
  overlay.classList.remove('show');
}

function ensureAttachmentViewer() {
  let overlay = $('attachmentViewer');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.className = 'attachment-viewer';
  overlay.id = 'attachmentViewer';
  overlay.innerHTML = `
    <section class="attachment-viewer-panel" role="dialog" aria-modal="true" aria-label="Attachment preview">
      <div class="attachment-viewer-bar">
        <button type="button" class="attachment-viewer-action attachment-viewer-close" id="attachmentViewerClose" aria-label="Back to chat">
          <i class="fas fa-arrow-left" aria-hidden="true"></i><span>Back</span>
        </button>
        <span class="attachment-viewer-name" id="attachmentViewerName"></span>
        <a class="attachment-viewer-action" id="attachmentOpenLink" target="_blank" rel="noopener">
          <i class="fas fa-arrow-up-right-from-square"></i><span>Open</span>
        </a>
        <a class="attachment-viewer-action" id="attachmentDownloadLink">
          <i class="fas fa-download"></i><span>Download / Save</span>
        </a>
      </div>
      <div class="attachment-viewer-body" id="attachmentViewerBody"></div>
    </section>`;
  document.body.appendChild(overlay);

  const close = () => closeAttachmentViewer();
  $('attachmentViewerClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return overlay;
}

async function openAttachment(file, cacheKey) {
  try {
    const url = await blobUrl(cacheKey, file);
    const overlay = ensureAttachmentViewer();
    const body = $('attachmentViewerBody');
    body.replaceChildren();
    $('attachmentViewerName').textContent = file.name || 'Attachment';

    const openLink = $('attachmentOpenLink');
    openLink.href = url;
    const downloadLink = $('attachmentDownloadLink');
    downloadLink.href = url;
    downloadLink.download = file.name || 'attachment';

    if ((file.mime || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = file.name || 'Image attachment';
      body.appendChild(img);
    } else if (file.mime === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.title = file.name || 'PDF preview';
      body.appendChild(frame);
    } else {
      const note = document.createElement('p');
      note.textContent = 'Preview is not available for this file. Use Open or Download / Save.';
      note.style.cssText = 'color:white;padding:20px;text-align:center';
      body.appendChild(note);
    }
    if (!overlay.classList.contains('show')) {
      const state = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...state, mgmAttachmentViewer: true }, '');
      overlay.classList.add('show');
    }
  } catch (e) {
    console.error('Attachment preview failed:', e);
    toast('Unable to open the file. Please download it again.', 'fa-triangle-exclamation');
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
    blobUrl(cacheKey, file).then((u) => { img.src = u; img.style.cursor = 'zoom-in'; img.onclick = () => openAttachment(file, cacheKey); })
      .catch(() => { img.replaceWith(emptyNote('Unable to load image.')); });
  }
  const fb = document.createElement('div');
  fb.className = 'file-bubble' + (isImg ? ' image-file-info' : '');
  fb.style.cursor = 'pointer';
  const icon = isImg ? 'fa-image' : (file.mime === 'application/pdf' ? 'fa-file-pdf' : 'fa-file');
  fb.innerHTML = `<div class="f-icon"><i class="fas ${icon}"></i></div>
    <div class="f-info"><div class="f-name">${esc(file.name)}</div><div class="f-size">${formatSize(file.size || 0)}</div></div>`;
  fb.setAttribute('role', 'button');
  fb.tabIndex = 0;
  fb.setAttribute('aria-label', `Open ${file.name || 'attachment'}`);
  fb.onclick = () => openAttachment(file, cacheKey);
  fb.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAttachment(file, cacheKey); } };
  box.appendChild(fb);
  return box;
}

function blobUrl(key, file) {
  if (!S.blobs.has(key)) {
    S.blobs.set(key, decryptFile(file).then((b) => URL.createObjectURL(b)).catch((e) => { S.blobs.delete(key); throw e; }));
  }
  return S.blobs.get(key);
}

function makeReceiptTicks(m) {
  const ticks = document.createElement('span');
  const status = m.pending ? 'sending' : (m.receipt || 'sent');
  ticks.className = 'receipt-ticks ' + (status === 'sending' ? 'tick-pending'
    : status === 'sent' ? 'tick-sent' : status === 'read' ? 'tick-read' : 'tick-delivered');
  if (status === 'sending') {
    const clock = document.createElement('i');
    clock.className = 'fas fa-clock';
    clock.setAttribute('aria-hidden', 'true');
    ticks.appendChild(clock);
  } else {
    const checkCount = status === 'sent' ? 1 : 2;
    for (let i = 0; i < checkCount; i++) {
      const check = document.createElement('span');
      check.className = 'receipt-check';
      check.textContent = '\u2713';
      ticks.appendChild(check);
    }
  }
  ticks.title = status === 'sending' ? 'Sending'
    : status === 'read' ? 'Seen' : status === 'delivered' ? 'Delivered' : 'Sent';
  ticks.setAttribute('aria-label', ticks.title);
  return ticks;
}

function msgRow(m) {
  const mine = m.sender_id === S.me;
  const conversation = S.convs.get(m.conversation_id);
  const p = m._p || {};
  const deleted = Boolean(m.deleted_at || p.t === 'deleted');
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'out' : 'in');
  row.dataset.messageId = m.id;
  const wrap = document.createElement('div'); wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (conversation?.isGroup) {
    const sender = conversation.members.find((member) => member.id === m.sender_id);
    const senderName = document.createElement('div');
    senderName.className = 'group-sender-label';
    senderName.textContent = mine ? 'You' : (sender?.full_name || 'Group member');
    bubble.appendChild(senderName);
  }
  if (p.replyTo?.messageId) {
    const quotedSender = p.replyTo.senderId === S.me
      ? 'You'
      : conversation?.isGroup
        ? (conversation.members.find((member) => member.id === p.replyTo.senderId)?.full_name || p.replyTo.senderName || 'Group member')
        : (conversation?.other.full_name || p.replyTo.senderName || 'Contact');
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'reply-quote';
    quote.setAttribute('aria-label', `Reply to ${quotedSender}: ${p.replyTo.excerpt || 'Message'}`);
    const author = document.createElement('span'); author.className = 'reply-quote-author';
    author.textContent = quotedSender;
    const excerpt = document.createElement('span'); excerpt.className = 'reply-quote-text';
    excerpt.textContent = p.replyTo.excerpt || 'Message';
    quote.append(author, excerpt);
    quote.addEventListener('click', (event) => {
      event.stopPropagation();
      jumpToReply(conversation, p.replyTo.messageId);
    });
    bubble.appendChild(quote);
  }
  let messageActions = null;
  if (p._err) {
    bubble.classList.add('unavailable-bubble');
    const notice = document.createElement('div'); notice.className = 'message-unavailable';
    const icon = document.createElement('i'); icon.className = 'fas fa-lock'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = 'Unable to display this message on this device.';
    notice.append(icon, label); bubble.appendChild(notice);
  } else if (deleted) {
    bubble.classList.add('deleted-bubble');
    const t = document.createElement('div'); t.className = 'deleted-message'; t.textContent = 'This message was deleted'; bubble.appendChild(t);
  } else {
    if (p.t === 'file' && p.file) bubble.appendChild(fileEl(p.file, m.id));
    if (p.text) { const t = document.createElement('div'); appendTextWithLinks(t, p.text); bubble.appendChild(t); }
  }

  if (!deleted && !p._err) {
    const reactions = m.reactions || [];
    if (!m.archived && reactions.length) {
      const counts = new Map();
      for (const r of reactions) {
        const entry = counts.get(r.emoji) || { count: 0, mine: false };
        entry.count++; if (r.user_id === S.me) entry.mine = true;
        counts.set(r.emoji, entry);
      }
      const strip = document.createElement('div'); strip.className = 'reaction-strip';
      for (const [emoji, value] of counts) {
        const chip = document.createElement('button');
        chip.className = 'reaction-chip' + (value.mine ? ' mine' : '');
        chip.type = 'button'; chip.textContent = `${emoji} ${value.count}`;
        chip.title = 'Tap to add or remove your reaction';
        chip.addEventListener('click', () => toggleReaction(S.convs.get(m.conversation_id), m, emoji));
        strip.appendChild(chip);
      }
      bubble.appendChild(strip);
    }

    const actions = document.createElement('div'); actions.className = 'message-actions';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button'; moreBtn.className = 'message-menu-trigger'; moreBtn.title = 'Message actions';
    moreBtn.disabled = Boolean(m.pending);
    moreBtn.setAttribute('aria-label', 'Message actions');
    moreBtn.innerHTML = '<i class="fas fa-ellipsis"></i>';
    const picker = document.createElement('div'); picker.className = 'reaction-picker';
    if (m.archived) picker.style.display = 'none';
    const menu = document.createElement('div'); menu.className = 'message-action-popover';
    menu.setAttribute('role', 'menu');
    for (const emoji of [String.fromCodePoint(0x1F44D), String.fromCharCode(0x2764, 0xFE0F), String.fromCodePoint(0x1F602), String.fromCodePoint(0x1F62E), String.fromCodePoint(0x1F622), String.fromCodePoint(0x1F64F)]) {
      const choice = document.createElement('button'); choice.type = 'button'; choice.textContent = emoji; choice.title = `React ${emoji}`;
      choice.setAttribute('aria-label', `React ${emoji}`);
      choice.addEventListener('click', () => { setMenuOpen(false); toggleReaction(S.convs.get(m.conversation_id), m, emoji); });
      picker.appendChild(choice);
    }
    menu.appendChild(picker);
    const positionMenu = () => {
      if (!window.matchMedia('(max-width: 900px)').matches) {
        menu.style.removeProperty('left');
        menu.style.removeProperty('top');
        menu.style.removeProperty('width');
        return;
      }
      const width = Math.min(290, window.innerWidth - 24);
      const bubbleRect = bubble.getBoundingClientRect();
      menu.style.width = `${width}px`;
      menu.style.left = '12px';
      menu.style.top = '12px';
      requestAnimationFrame(() => {
        if (!menu.classList.contains('show')) return;
        const menuRect = menu.getBoundingClientRect();
        const leftTarget = mine ? bubbleRect.right - menuRect.width : bubbleRect.left;
        const left = Math.max(12, Math.min(leftTarget, window.innerWidth - menuRect.width - 12));
        const above = bubbleRect.top - menuRect.height - 8;
        const top = above >= 12 ? above : Math.min(bubbleRect.bottom + 8, window.innerHeight - menuRect.height - 12);
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(12, top)}px`;
      });
    };
    const setMenuOpen = (open) => {
      menu.classList.toggle('show', open);
      row.classList.toggle('context-open', open);
      moreBtn.setAttribute('aria-expanded', String(open));
      if (open) positionMenu();
    };
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenuOpen(!menu.classList.contains('show')); });
    actions.addEventListener('click', (e) => e.stopPropagation());

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button'; replyBtn.className = 'message-menu-item';
    replyBtn.innerHTML = '<i class="fas fa-reply"></i><span>Reply</span>';
    replyBtn.addEventListener('click', () => {
      setMenuOpen(false);
      setReplyTarget(conversation, m);
    });
    menu.appendChild(replyBtn);
    let holdTimer = null;
    let holdTriggered = false;
    let lastTapAt = 0;
    let suppressMenuClick = false;
    bubble.addEventListener('pointerdown', (e) => {
      if (m.pending || e.pointerType !== 'touch' || e.target.closest('button, a, input')) return;
      const now = Date.now();
      const canDoubleTap = !e.target.closest('img');
      if (canDoubleTap && lastTapAt && now - lastTapAt < 360) {
        e.preventDefault();
        suppressMenuClick = true;
        lastTapAt = 0;
        setMenuOpen(true);
        return;
      }
      lastTapAt = canDoubleTap ? now : 0;
      holdTriggered = false;
      holdTimer = setTimeout(() => { setMenuOpen(true); holdTriggered = true; holdTimer = null; }, 480);
    });
    bubble.addEventListener('click', (e) => {
      if (suppressMenuClick) {
        e.preventDefault(); e.stopPropagation();
        suppressMenuClick = false;
        return;
      }
      if (!holdTriggered) return;
      e.preventDefault(); e.stopPropagation();
      holdTriggered = false;
    }, true);
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
      bubble.addEventListener(eventName, () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
    }
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!m.pending) setMenuOpen(true); });
    actions.append(moreBtn, menu);

    const ageMs = Date.now() - new Date(m.created_at).getTime();
    if (!m.archived && mine) {
      if (p.t === 'text' && ageMs <= 15 * 60 * 1000) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button'; editBtn.className = 'message-menu-item';
        editBtn.innerHTML = '<i class="fas fa-pen"></i><span>Edit message</span>';
        editBtn.addEventListener('click', () => { setMenuOpen(false); editMessage(S.convs.get(m.conversation_id), m); });
        menu.appendChild(editBtn);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button'; deleteBtn.className = 'message-menu-item danger';
      deleteBtn.innerHTML = '<i class="fas fa-trash-can"></i><span>Unsend message</span>';
      deleteBtn.addEventListener('click', () => { setMenuOpen(false); deleteMessage(S.convs.get(m.conversation_id), m); });
      menu.appendChild(deleteBtn);
    }
    messageActions = actions;
  }
  const meta = document.createElement('div'); meta.className = 'meta-line';
  meta.innerHTML = (m.edited_at && !deleted ? 'Edited - ' : '') + fmtTime(m.created_at);
  if (mine) {
    meta.append(' ', makeReceiptTicks(m));
  }
  bubble.appendChild(meta);
  wrap.appendChild(bubble);
  if (messageActions) wrap.appendChild(messageActions);
  row.appendChild(wrap);
  return row;
}

async function toggleReaction(c, m, emoji) {
  if (!c || !m || m.deleted_at) return;
  const mine = (m.reactions || []).find((r) => r.user_id === S.me);
  let result;
  if (mine?.emoji === emoji) {
    result = await supabase.from('message_reactions').delete().eq('message_id', m.id).eq('user_id', S.me);
  } else {
    try {
      const encrypted = await encryptPayload(await keyFor(c, m.group_key_version || 1), { t: 'reaction', emoji });
      result = await supabase.from('message_reactions').upsert(
        { message_id: m.id, user_id: S.me, ...encrypted }, { onConflict: 'message_id,user_id' }
      );
    } catch (e) { toast('Unable to encrypt reaction: ' + e.message, 'fa-triangle-exclamation'); return; }
  }
  if (result.error) { toast('Unable to save reaction: ' + result.error.message, 'fa-triangle-exclamation'); return; }
  await refreshReactions(c, m);
}

async function refreshReactions(c, m) {
  const { data, error } = await supabase.from('message_reactions')
    .select('message_id,user_id,ciphertext,iv').eq('message_id', m.id);
  if (error) { toast('Unable to load reactions: ' + error.message, 'fa-triangle-exclamation'); return; }
  m.reactions = [];
  for (const ciph of data || []) {
    try {
      const decoded = await decryptPayload(await keyFor(c, m.group_key_version || 1), ciph);
      m.reactions.push({ ...ciph, emoji: decoded.emoji });
    } catch (e) { console.error('Reaction decrypt failed:', e.message); }
  }
  if (S.current === c.id) renderMessages(c, 'stay');
}

let pendingMessageEdit = null;
function editMessage(c, m) {
  if (!c || !m || m.sender_id !== S.me || m._p?.t !== 'text') return;
  pendingMessageEdit = { c, m };
  $('messageEditText').value = m._p.text || '';
  $('messageEditModal').classList.add('show');
  setTimeout(() => $('messageEditText').focus(), 50);
}

async function saveEditedMessage() {
  const target = pendingMessageEdit;
  if (!target) return;
  const { c, m } = target;
  const text = $('messageEditText').value.trim();
  if (!text) { toast('Message cannot be empty.', 'fa-triangle-exclamation'); return; }
  $('messageEditSave').disabled = true;
  try {
    const encrypted = await encryptPayload(await keyFor(c, m.group_key_version || 1), { t: 'text', text });
    const { error } = await supabase.rpc('edit_message', {
      p_message_id: m.id, p_ciphertext: encrypted.ciphertext, p_iv: encrypted.iv
    });
    if (error) throw error;
    m.ciphertext = encrypted.ciphertext; m.iv = encrypted.iv;
    m._p = { t: 'text', text }; m.edited_at = new Date().toISOString();
    if (c.messages.at(-1)?.id === m.id) c.preview = previewOf(m);
    $('messageEditModal').classList.remove('show');
    pendingMessageEdit = null;
    if (S.current === c.id) renderMessages(c, 'stay');
    renderLists(); toast('Message edited');
  } catch (e) { toast('Unable to edit message: ' + e.message, 'fa-triangle-exclamation'); }
  finally { $('messageEditSave').disabled = false; }
}

let pendingMessageDelete = null;
function deleteMessage(c, m) {
  if (!c || !m || m.sender_id !== S.me || m.deleted_at) return;
  pendingMessageDelete = { c, m };
  $('messageDeleteModal').classList.add('show');
}

async function confirmDeleteMessage() {
  const target = pendingMessageDelete;
  if (!target) return;
  const { c, m } = target;
  $('messageDeleteConfirm').disabled = true;
  try {
    const encrypted = await encryptPayload(await keyFor(c, m.group_key_version || 1), { t: 'deleted' });
    const { error } = await supabase.rpc('delete_message', {
      p_message_id: m.id, p_ciphertext: encrypted.ciphertext, p_iv: encrypted.iv
    });
    if (error) throw error;
    m.ciphertext = encrypted.ciphertext; m.iv = encrypted.iv;
    m._p = { t: 'deleted' }; m.deleted_at = new Date().toISOString(); m.edited_at = null; m.reactions = [];
    $('messageDeleteModal').classList.remove('show');
    pendingMessageDelete = null;
    if (c.messages.at(-1)?.id === m.id) c.preview = previewOf(m);
    if (S.current === c.id) renderMessages(c, 'stay');
    renderLists(); toast('Message unsent for everyone', 'fa-trash-can');
  } catch (e) { toast('Unable to delete message: ' + e.message, 'fa-triangle-exclamation'); }
  finally { $('messageDeleteConfirm').disabled = false; }
}

function pendingUploadRow(pending) {
  const { file } = pending;
  const row = document.createElement('div');
  row.className = 'msg-row out pending-upload-row';
  row.dataset.pendingUploadId = pending.id;

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'bubble pending-upload-bubble';

  if (file.type.startsWith('image/')) {
    const preview = document.createElement('div');
    preview.className = 'pending-upload-preview';
    const image = document.createElement('img');
    image.className = 'pending-upload-image';
    image.src = pending.previewUrl;
    image.alt = file.name || 'Photo being sent';
    const overlay = document.createElement('div');
    overlay.className = 'pending-upload-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('i');
    spinner.className = 'fas fa-spinner pending-upload-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.textContent = pending.status;
    overlay.append(spinner, status);
    preview.append(image, overlay);
    bubble.appendChild(preview);
  } else {
    const fileCard = document.createElement('div');
    fileCard.className = 'pending-upload-file';
    const icon = document.createElement('span');
    icon.className = 'pending-upload-file-icon';
    icon.innerHTML = `<i class="fas ${file.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file'}" aria-hidden="true"></i>`;
    const copy = document.createElement('span');
    copy.className = 'pending-upload-file-copy';
    const name = document.createElement('span');
    name.className = 'pending-upload-file-name';
    name.textContent = file.name || 'Attachment';
    const size = document.createElement('small');
    size.textContent = formatSize(file.size || 0);
    copy.append(name, size);
    fileCard.append(icon, copy);
    bubble.appendChild(fileCard);

    const status = document.createElement('div');
    status.className = 'pending-upload-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('i');
    spinner.className = 'fas fa-spinner pending-upload-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = pending.status;
    status.append(spinner, label);
    bubble.appendChild(status);
  }

  if (pending.caption) {
    const caption = document.createElement('div');
    caption.className = 'pending-upload-caption';
    caption.textContent = pending.caption;
    bubble.appendChild(caption);
  }
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  return row;
}

// mode: 'bottom' (naya msg/open), 'prepend' (purane upar add hue), 'stay'
function renderMessages(c, mode = 'bottom') {
  const area = $('messagesArea');
  const prevH = area.scrollHeight, prevTop = area.scrollTop;
  const wasNearBottom = prevH - prevTop - area.clientHeight < 120;
  const frag = document.createDocumentFragment();

  if (c.loading && c.loaded) frag.appendChild(emptyNote('Loading messages…'));
  else if (c.liveExhausted && c.archiveDone && c.messages.length) frag.appendChild(emptyNote('Start of conversation'));

  if (!c.messages.length && c.loaded && !c.loading) {
    frag.appendChild(emptyNote(c.liveExhausted && c.archiveDone ? 'No messages yet. Send the first message' : 'Scroll up to view older messages.'));
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
  for (const pending of c.pendingUploads || []) frag.appendChild(pendingUploadRow(pending));
  area.replaceChildren(frag);

  if (mode === 'bottom') area.scrollTop = area.scrollHeight;
  else if (mode === 'prepend') area.scrollTop = area.scrollHeight - prevH + prevTop;
  else area.scrollTop = wasNearBottom
    ? area.scrollHeight
    : Math.min(prevTop, Math.max(0, area.scrollHeight - area.clientHeight));
}

function appendOptimisticMessage(c, message) {
  if (S.current !== c.id) return;
  if (c.messages.at(-1) !== message) {
    renderMessages(c, 'bottom');
    return;
  }
  const area = $('messagesArea');
  const previousRow = [...area.children].reverse()
    .find((element) => element.classList.contains('msg-row') && element.dataset.messageId);
  const previousMessage = previousRow && c.messages.find((item) => item.id === previousRow.dataset.messageId);
  if (!previousRow) {
    area.querySelectorAll(':scope > .empty-note').forEach((note) => note.remove());
  }
  if (!previousMessage || new Date(previousMessage.created_at).toDateString() !== new Date(message.created_at).toDateString()) {
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.innerHTML = `<span>${esc(dayLabel(message.created_at))}</span>`;
    area.appendChild(divider);
  }
  area.appendChild(msgRow(message));
  area.scrollTop = area.scrollHeight;
}

function reconcilePendingMessage(c, pending, saved) {
  const oldIndex = c.messages.indexOf(pending);
  if (oldIndex < 0 || !pending.pending) return false;
  const oldId = pending.id;
  const oldDay = new Date(pending.created_at).toDateString();
  c.ids.delete(oldId);
  Object.assign(pending, saved, {
    _p: pending._p,
    reactions: pending.reactions || [],
    receipt: 'sent',
    pending: false
  });
  c.ids.add(pending.id);
  c.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const newIndex = c.messages.indexOf(pending);
  const row = [...$('messagesArea').querySelectorAll('.msg-row')]
    .find((element) => element.dataset.messageId === oldId);
  const reordered = oldIndex !== newIndex || oldDay !== new Date(pending.created_at).toDateString();
  if (S.current === c.id) {
    if (reordered) renderMessages(c, 'stay');
    else if (row) {
      row.dataset.messageId = pending.id;
      const meta = row.querySelector('.meta-line');
      if (meta?.firstChild?.nodeType === Node.TEXT_NODE) meta.firstChild.textContent = fmtTime(pending.created_at);
      row.querySelector('.receipt-ticks')?.replaceWith(makeReceiptTicks(pending));
      row.querySelector('.message-menu-trigger')?.removeAttribute('disabled');
    }
  }
  if (c.messages.at(-1) === pending) {
    c.preview = previewOf(pending);
    c.lastAt = pending.created_at;
  }
  renderListsSoon();
  return true;
}

function rollbackOptimisticMessage(c, message) {
  const index = c.messages.indexOf(message);
  if (index < 0) return;
  const wasLast = index === c.messages.length - 1;
  c.messages.splice(index, 1);
  c.ids.delete(message.id);
  if (wasLast) {
    const latest = c.messages.at(-1);
    c.preview = latest ? previewOf(latest) : message.previousPreview;
    c.lastAt = latest?.created_at || message.previousLastAt;
  }
  renderListsSoon();
  if (S.current === c.id) renderMessages(c, 'stay');
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
  if (S.attachmentSending && S.current !== id) {
    toast('Wait for the selected files to finish sending.', 'fa-triangle-exclamation');
    return;
  }
  if (S.attachmentDraft.length && S.attachmentDraftConversationId !== id) clearAttachmentDraft();
  if (S.replyTarget?.conversationId !== id) clearReplyTarget();
  S.current = id;
  c.unread = 0;
  renderLists();
  renderChatWindow();
  $('moreMenu').classList.remove('show');
  openMobilePane();

  if (!S.priv) {
    $('messagesArea').replaceChildren(lockedNote());
    return;
  }
  if (!c.loaded) {
    $('messagesArea').replaceChildren(emptyNote('Loading messages...'));
    try { await loadInitial(c); }
    catch (e) { console.error(e); $('messagesArea').replaceChildren(emptyNote('Unable to load messages.')); return; }
  }
  if (S.current !== id) return;
  renderMessages(c, 'bottom');
  if (pendingResourceShare && S.priv && (c.isGroup || !S.blocked.has(c.other.id)) && !(c.status === 'pending' && c.requestedBy !== S.me)) {
    $('msgInput').value = pendingResourceShare;
    pendingResourceShare = '';
    toast('The notes link is ready. Review it before sending.', 'fa-link');
  }
  await recordReceived(c, c.messages, true);
  // Refresh receipt ticks in place so the message list and scroll position stay put.
  await refreshOutgoingReceipts(c);
  fillIfShort(c);
}

/* ====================== sending ====================== */
function messageExcerpt(m) {
  if (!m) return 'Message';
  if (m._p?._err) return 'Message unavailable';
  if (m.deleted_at || m._p?.t === 'deleted') return 'This message was deleted';
  const payload = m._p || {};
  if (payload.t === 'file') {
    const file = payload.file || {};
    const kind = (file.mime || '').startsWith('image/') ? 'Photo' : file.mime === 'application/pdf' ? 'PDF' : 'Attachment';
    return file.name ? `${kind}: ${file.name}` : kind;
  }
  return String(payload.text || 'Message').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function replyDescriptorFor(c) {
  const target = S.replyTarget;
  if (!c || target?.conversationId !== c.id) return null;
  return target.quote;
}

function setReplyTarget(c, m) {
  if (!c || !m) return;
  const sender = c.isGroup ? c.members.find((member) => member.id === m.sender_id) : c.other;
  S.replyTarget = {
    conversationId: c.id,
    quote: {
      messageId: m.id,
      senderId: m.sender_id,
      senderName: m.sender_id === S.me ? 'You' : (sender?.full_name || (c.isGroup ? 'Group member' : 'Contact')),
      excerpt: messageExcerpt(m)
    }
  };
  renderReplyComposer(c);
  $('msgInput').focus();
}

function clearReplyTarget(conversationId = null, messageId = null) {
  if (!S.replyTarget) { renderReplyComposer(cur()); return; }
  if (conversationId && S.replyTarget.conversationId !== conversationId) return;
  if (messageId && S.replyTarget.quote.messageId !== messageId) return;
  S.replyTarget = null;
  renderReplyComposer(cur());
}

function renderReplyComposer(c = cur()) {
  const box = $('replyComposerPreview');
  if (!box) return;
  const target = S.replyTarget;
  if (!S.priv || !c || target?.conversationId !== c.id) {
    box.style.display = 'none';
    return;
  }
  $('replyComposerAuthor').textContent = `Replying to ${target.quote.senderName}`;
  $('replyComposerText').textContent = target.quote.excerpt;
  box.style.display = 'flex';
}

function jumpToReply(c, messageId) {
  const message = c?.messages.find((item) => item.id === messageId);
  const row = message && [...$('messagesArea').querySelectorAll('.msg-row')]
    .find((item) => item.dataset.messageId === messageId);
  if (!row) {
    toast('The original message is not in the loaded history. The quoted text is shown above.', 'fa-message');
    return;
  }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('reply-target-flash');
  setTimeout(() => row.classList.remove('reply-target-flash'), 1500);
}

function sendErrorMessage(e) {
  if (e?.message === 'NO_LOCAL_KEY') return 'Chat locked: unlock it with your Security Keyword.';
  if (e?.message === 'NO_PEER_KEY') return 'This user has not set up encryption keys yet.';
  if (e?.code === '42501') return 'Message could not be sent. The request may be pending, or this user may be blocked.';
  return 'Message could not be sent: ' + (e?.message || 'Unknown error');
}

async function sendPayload(c, payload, optimisticMessage = null) {
  const keyVersion = c.isGroup ? c.groupKeyVersion : null;
  const key = await keyFor(c, keyVersion || undefined);
  const { ciphertext, iv } = await encryptPayload(key, payload);
  if (optimisticMessage) {
    optimisticMessage.ciphertext = ciphertext;
    optimisticMessage.iv = iv;
    if (c.isGroup) optimisticMessage.group_key_version = keyVersion;
  }
  const messageRow = { conversation_id: c.id, sender_id: S.me, ciphertext, iv };
  if (c.isGroup) messageRow.group_key_version = keyVersion;
  const { data, error } = await supabase.from('messages')
    .insert(messageRow).select().single();
  if (error) throw error;
  data._p = payload;                       // already plain hai, dobara decrypt nahi
  let reconciled = false;
  if (optimisticMessage && c.messages.includes(optimisticMessage)) {
    reconciled = optimisticMessage.pending
      ? reconcilePendingMessage(c, optimisticMessage, data)
      : true;
  } else if (!c.clearedBefore || new Date(data.created_at) > new Date(c.clearedBefore)) {
    await addMessages(c, [data]);
    c.preview = previewOf(data);
    c.lastAt = data.created_at;
  }
  if (!reconciled) {
    renderListsSoon();
    if (S.current === c.id) renderMessages(c, 'bottom');
  }
  void archiveOverflow(c);
}

function addOptimisticText(c, payload) {
  const message = {
    id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    conversation_id: c.id,
    sender_id: S.me,
    created_at: new Date().toISOString(),
    _p: payload,
    reactions: [],
    receipt: 'sending',
    pending: true,
    previousPreview: c.preview,
    previousLastAt: c.lastAt
  };
  c.ids.add(message.id);
  c.messages.push(message);
  c.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  c.preview = previewOf(message);
  c.lastAt = message.created_at;
  appendOptimisticMessage(c, message);
  renderListsSoon();
  return message;
}

async function sendText() {
  const c = cur();
  const input = $('msgInput');
  const text = input.value.trim();
  if (!c || !text) return;
  const replyTo = replyDescriptorFor(c);
  const payload = { t: 'text', text, ...(replyTo ? { replyTo } : {}) };
  input.value = '';
  const optimisticMessage = addOptimisticText(c, payload);
  try {
    await sendPayload(c, payload, optimisticMessage);
    if (replyTo) clearReplyTarget(c.id, replyTo.messageId);
  } catch (e) {
    rollbackOptimisticMessage(c, optimisticMessage);
    if (S.current === c.id && !input.value) input.value = text;
    toast(sendErrorMessage(e), 'fa-triangle-exclamation');
  }
}

async function uploadToCloudinary(blob) {
  const fd = new FormData();
  // Cloudinary blocks .bin extensions; ciphertext is stored as an opaque raw .dat asset.
  fd.append('file', blob, 'enc.dat');
  fd.append('upload_preset', CLOUDINARY_PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, { method: 'POST', body: fd });
  if (!r.ok) {
    const body = await r.text();
    let detail = r.headers.get('X-Cld-Error') || '';
    try { detail ||= JSON.parse(body)?.error?.message || ''; } catch { /* response may not be JSON */ }
    throw new Error('Cloudinary upload fail (' + r.status + ')' + (detail ? ': ' + detail : ''));
  }
  return (await r.json()).secure_url;
}

async function uploadArchiveToCloudinary(messages) {
  const archive = new Blob([JSON.stringify({ messages })], { type: 'application/json' });
  const fd = new FormData();
  fd.append('file', archive, `chat-archive-${Date.now()}.json`);
  fd.append('upload_preset', CLOUDINARY_PRESET);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, {
    method: 'POST', body: fd
  });
  if (!response.ok) {
    const body = await response.text();
    let detail = response.headers.get('X-Cld-Error') || '';
    try { detail ||= JSON.parse(body)?.error?.message || ''; } catch { /* response may not be JSON */ }
    throw new Error('Chat archive upload failed (' + response.status + ')' + (detail ? ': ' + detail : ''));
  }
  const result = await response.json();
  if (!result.secure_url) throw new Error('Cloudinary did not return a secure archive URL.');
  return result.secure_url;
}

async function archiveOverflow(c) {
  if (!c || !CLOUDINARY_CLOUD || CLOUDINARY_CLOUD.startsWith('YOUR')) return;
  if (archivingConversations.has(c.id)) { pendingArchiveChecks.add(c.id); return; }
  archivingConversations.add(c.id);
  let updated = false;
  try {
    while (true) {
      const cutoff = new Date(Date.now() - CHAT_ARCHIVE_AGE_MS).toISOString();
      let recentQuery = supabase.from('messages').select('id').eq('conversation_id', c.id)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(CHAT_ARCHIVE_KEEP_RECENT);
      if (c.isGroup && c.myJoinedAt) recentQuery = recentQuery.gte('created_at', c.myJoinedAt);
      const { data: recentMessages, error: recentError } = await recentQuery;
      if (recentError) throw recentError;
      const recentIds = (recentMessages || []).map((message) => message.id);
      if (recentIds.length < CHAT_ARCHIVE_KEEP_RECENT) break;

      let query = supabase.from('messages').select('*').eq('conversation_id', c.id)
        .lt('created_at', cutoff).not('id', 'in', `(${recentIds.join(',')})`)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .limit(CHAT_ARCHIVE_BATCH_SIZE);
      if (c.isGroup && c.myJoinedAt) query = query.gte('created_at', c.myJoinedAt);
      const { data: messages, error: selectError } = await query;
      if (selectError) throw selectError;
      if (!(messages || []).length) break;

      // Preserve a small live window; never delete until Cloudinary has accepted
      // the archive and Supabase has committed its index row.
      const url = await uploadArchiveToCloudinary(messages);
      const { data: archiveResult, error: archiveError } = await supabase.functions.invoke('archive-chat', {
        body: {
          p_conversation_id: c.id,
          p_message_ids: messages.map((message) => message.id),
          p_url: url,
          p_archive_date: messages[0].created_at.slice(0, 10),
          p_cutoff: cutoff
        }
      });
      if (archiveError) throw archiveError;
      const archivedCount = Number(archiveResult?.archived_count) || 0;
      if (!archivedCount) break;

      const archivedIds = new Set(messages.map((message) => message.id));
      c.messages.forEach((message) => { if (archivedIds.has(message.id)) message.archived = true; });
      updated = true;
      c.archiveFiles = null;
      c.archiveIdx = 0;
      c.archiveDone = false;
      archiveWarnings.delete(c.id);
    }
  } catch (error) {
    console.error('Chat archive failed:', error?.message || error, error);
    if (!archiveWarnings.has(c.id)) {
      archiveWarnings.add(c.id);
      toast('Chat history could not be archived. Check the archive setup and try again.', 'fa-triangle-exclamation');
    }
  } finally {
    archivingConversations.delete(c.id);
    if (updated && S.current === c.id) renderMessages(c, 'stay');
    if (pendingArchiveChecks.delete(c.id)) queueMicrotask(() => archiveOverflow(c));
  }
}

async function sendAttachment(file, conversation = cur(), replyTo = undefined, caption = '') {
  const c = conversation;
  if (!c || !file) return false;
  if (!(file.type.startsWith('image/') || file.type === 'application/pdf')) {
    toast(`${file.name}: only images and PDFs can be sent.`, 'fa-triangle-exclamation'); return false;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast(`${file.name}: exceeds the ${formatSize(MAX_FILE_BYTES)} size limit.`, 'fa-triangle-exclamation'); return false;
  }
  if (!CLOUDINARY_CLOUD || CLOUDINARY_CLOUD.startsWith('YOUR')) {
    toast('Add your Cloudinary credentials to chat-config.js.', 'fa-triangle-exclamation'); return false;
  }
  const messageReply = replyTo === undefined ? replyDescriptorFor(c) : replyTo;
  const pending = {
    id: `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file,
    previewUrl: URL.createObjectURL(file),
    caption,
    status: 'Encrypting...'
  };
  c.pendingUploads ||= [];
  c.pendingUploads.push(pending);
  if (S.current === c.id) renderMessages(c, 'bottom');
  try {
    const enc = await encryptFile(file);
    pending.status = 'Uploading...';
    if (S.current === c.id) renderMessages(c, 'bottom');
    const url = await uploadToCloudinary(enc.blob);
    await sendPayload(c, {
      t: 'file', text: caption,
      file: { url, key: enc.key, iv: enc.iv, name: file.name, size: file.size, mime: file.type },
      ...(messageReply ? { replyTo: messageReply } : {})
    });
    toast(`${file.name} sent.`);
    return true;
  } catch (e) { toast(sendErrorMessage(e), 'fa-triangle-exclamation'); return false; }
  finally {
    c.pendingUploads = (c.pendingUploads || []).filter((item) => item.id !== pending.id);
    URL.revokeObjectURL(pending.previewUrl);
    if (S.current === c.id) renderMessages(c, 'bottom');
  }
}

function renderAttachmentDraft() {
  const tray = $('attachmentDraft');
  const list = $('attachmentDraftItems');
  const count = $('attachmentDraftCount');
  if (!tray || !list || !count) return;
  list.replaceChildren();
  tray.style.display = S.attachmentDraft.length ? 'block' : 'none';
  count.textContent = `${S.attachmentDraft.length} file${S.attachmentDraft.length === 1 ? '' : 's'} selected`;

  S.attachmentDraft.forEach((draft, index) => {
    const card = document.createElement('div');
    card.className = 'attachment-draft-item';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-draft-remove';
    remove.dataset.removeDraft = String(index);
    remove.setAttribute('aria-label', `Remove ${draft.file.name}`);
    remove.title = 'Remove';
    remove.disabled = S.attachmentSending;
    remove.innerHTML = '<i class="fas fa-xmark"></i>';
    if (draft.previewUrl) {
      const image = document.createElement('img');
      image.className = 'attachment-draft-thumb';
      image.src = draft.previewUrl;
      image.alt = draft.file.name;
      card.append(image);
    } else {
      const icon = document.createElement('div');
      icon.className = 'attachment-draft-file-icon';
      icon.innerHTML = `<i class="fas ${draft.file.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file'}"></i>`;
      card.append(icon);
    }
    const name = document.createElement('span');
    name.className = 'attachment-draft-name';
    name.textContent = draft.file.name;
    name.title = draft.file.name;
    const size = document.createElement('small');
    size.className = 'attachment-draft-size';
    size.textContent = formatSize(draft.file.size);
    card.append(remove, name, size);
    list.append(card);
  });
  $('clearAttachmentDraft').disabled = S.attachmentSending || !S.attachmentDraft.length;
}

function addAttachmentDraft(files) {
  const c = cur();
  if (!c || !files?.length) return;
  if (S.attachmentSending) {
    toast('An upload is in progress. Add more files after it finishes.', 'fa-triangle-exclamation');
    return;
  }
  if (S.attachmentDraftConversationId && S.attachmentDraftConversationId !== c.id) clearAttachmentDraft();
  S.attachmentDraftConversationId = c.id;
  for (const file of files) {
    const duplicate = S.attachmentDraft.some((draft) =>
      draft.file.name === file.name && draft.file.size === file.size && draft.file.lastModified === file.lastModified
    );
    if (duplicate) continue;
    S.attachmentDraft.push({
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    });
  }
  renderAttachmentDraft();
}

function removeAttachmentDraft(index) {
  if (S.attachmentSending) return;
  const [removed] = S.attachmentDraft.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  if (!S.attachmentDraft.length) S.attachmentDraftConversationId = null;
  renderAttachmentDraft();
}

function clearAttachmentDraft() {
  for (const draft of S.attachmentDraft) {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
  S.attachmentDraft = [];
  S.attachmentDraftConversationId = null;
  renderAttachmentDraft();
}

async function sendAttachments() {
  const c = S.convs.get(S.attachmentDraftConversationId);
  const selected = [...S.attachmentDraft];
  if (!c || !selected.length) return;
  if (S.attachmentSending) {
    return;
  }

  S.attachmentSending = true;
  const attachButton = document.querySelector('.attach-btn');
  const sendButton = document.querySelector('.send-btn');
  if (attachButton) attachButton.disabled = true;
  if (sendButton) sendButton.disabled = true;
  renderAttachmentDraft();

  // Send in order. The typed text becomes a caption on the first successful file.
  const replyTo = replyDescriptorFor(c);
  const caption = $('msgInput').value.trim();
  const sentDrafts = new Set();
  let captionSent = false;
  let sent = 0;
  try {
    for (const draft of selected) {
      const fileCaption = caption && !captionSent ? caption : '';
      if (await sendAttachment(draft.file, c, replyTo, fileCaption)) {
        sent++;
        sentDrafts.add(draft);
        if (fileCaption) captionSent = true;
      }
    }
  } finally {
    S.attachmentSending = false;
    if (attachButton) attachButton.disabled = false;
    if (sendButton) sendButton.disabled = false;
  }

  if (sentDrafts.size) {
    S.attachmentDraft = S.attachmentDraft.filter((draft) => {
      if (!sentDrafts.has(draft)) return true;
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      return false;
    });
    if (captionSent) $('msgInput').value = '';
    if (replyTo) clearReplyTarget(c.id, replyTo.messageId);
    if (!S.attachmentDraft.length) S.attachmentDraftConversationId = null;
  }
  renderAttachmentDraft();
  if (selected.length > 1) {
    toast(`${sent}/${selected.length} files sent`, sent === selected.length ? undefined : 'fa-triangle-exclamation');
  }
}

async function sendComposer() {
  if (S.attachmentSending) return;
  if (S.attachmentDraft.length) return sendAttachments();
  return sendText();
}

/* ====================== realtime ====================== */
async function onConvChange(row, isInsert) {
  let members = [];
  let profs;
  if (row.is_group) {
    const { data: rows, error } = await supabase.from('group_members')
      .select('conversation_id,user_id,role,joined_at').eq('conversation_id', row.id);
    if (error || !rows?.some((member) => member.user_id === S.me)) return;
    profs = await fetchProfiles(rows.map((member) => member.user_id));
    members = rows.map((member) => ({
      ...(profs.get(member.user_id) || { id: member.user_id, full_name: 'Unknown member' }),
      role: member.role, joined_at: member.joined_at
    }));
  } else {
    if (row.user_a !== S.me && row.user_b !== S.me) return;
    const known = S.convs.has(row.id);
    profs = known ? new Map() : await fetchProfiles([otherIdOf(row)]);
  }
  const known = S.convs.has(row.id);
  const c = upsertConv(row, profs, members);
  if (isInsert && !known && !row.is_group && row.requested_by !== S.me) toast('New message request: ' + c.other.full_name, 'fa-user-plus');
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
  if (c.ids.has(m.id)) return;                                   // already rendered locally or by realtime
  if (!c.isGroup && m.sender_id !== S.me && S.blocked.has(c.other.id)) return;
  if (c.clearedBefore && new Date(m.created_at) <= new Date(c.clearedBefore)) return;
  if (c.isGroup && c.myJoinedAt && new Date(m.created_at) < new Date(c.myJoinedAt)) return;

  if (m.sender_id === S.me) {
    const pending = c.messages.find((item) => item.pending
      && item.ciphertext === m.ciphertext && item.iv === m.iv);
    if (pending) {
      reconcilePendingMessage(c, pending, { ...m, _p: pending._p });
      void archiveOverflow(c);
      return;
    }
  }

  if (c.loaded) await addMessages(c, [m]); else await decryptMsg(c, m);
  c.preview = previewOf(m);
  c.lastAt = m.created_at;

  if (m.sender_id !== S.me) {
    if (S.current === c.id) {
      const area = $('messagesArea');
      const nearBottom = document.activeElement === $('msgInput')
        || area.scrollHeight - area.scrollTop - area.clientHeight < 140;
      renderMessages(c, nearBottom ? 'bottom' : 'stay');
      await recordReceived(c, [m], nearBottom);
    } else {
      await recordReceived(c, [m], false);
      c.unread++;
    }
  } else if (S.current === c.id) {
    renderMessages(c, 'bottom');
  }
  void archiveOverflow(c);
  renderLists();
}

async function onMessageUpdate(m) {
  const c = S.convs.get(m.conversation_id);
  if (!c) return;
  const idx = c.messages.findIndex((row) => row.id === m.id);
  if (idx < 0) return;
  m.reactions = c.messages[idx].reactions || [];
  m.receipt = c.messages[idx].receipt || 'sent';
  await decryptMsg(c, m);
  c.messages[idx] = m;
  if (c.messages.at(-1)?.id === m.id) c.preview = previewOf(m);
  if (S.current === c.id) renderMessages(c, 'stay');
  renderLists();
}

async function onReactionChange(payload) {
  const row = payload.new?.message_id ? payload.new : payload.old;
  if (!row?.message_id) return;
  for (const c of S.convs.values()) {
    const m = c.messages.find((item) => item.id === row.message_id);
    if (m) { await refreshReactions(c, m); return; }
  }
}

function markCurrentRead() {
  const c = cur();
  const area = $('messagesArea');
  const nearBottom = area && area.scrollHeight - area.scrollTop - area.clientHeight < 140;
  if (c?.loaded && document.visibilityState === 'visible') {
    if (nearBottom) recordReceived(c, c.messages, true);
  }
}

function subscribeRealtime() {
  supabase.channel('chat-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => onNewMessage(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => onMessageUpdate(p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, onReactionChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_receipts' }, onReceiptChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new, true))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new, false))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversations' }, onConversationDelete)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' }, onGroupMembersChange)
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
  if (!await portalConfirm('This clears all messages in the chat for you only. The contact will remain. Continue?', { danger: true, confirmText: 'Clear chat' })) return;
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
  if (!await portalConfirm('Reporting will send the last five decrypted messages in this chat to the moderators. Continue?', { confirmText: 'Send report' })) return;
  const evidence = c.messages.slice(-5).map((m) => ({
    from: m.sender_id === S.me ? 'reporter' : 'reported',
    at: m.created_at,
    text: m._p?.text || (m._p?.file ? '[file] ' + m._p.file.name : '')
  }));
  const { error } = await supabase.from('reports').insert({
    reporter: S.me, reported_user: c.other.id, conversation_id: c.id, evidence
  });
  toast(error ? 'Unable to submit report.' : 'Report submitted. The team will review it.', error ? 'fa-triangle-exclamation' : 'fa-flag');
}

/* ====================== new chat modal ====================== */
let searchTimer = null;
let groupSearchTimer = null;
const selectedGroupMembers = new Map();
async function searchPeople(raw) {
  const list = $('ncFriendList');
  const q = sanitizeQ(raw);
  if (q.length < 2) { list.replaceChildren(emptyNote('Enter at least two letters of a name or roll number.')); return; }
  const { data, error } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,public_key')
    .neq('id', S.me)
    .or(`full_name.ilike.%${q}%,roll_no.ilike.%${q}%`).limit(20);
  if (error) { list.replaceChildren(emptyNote('Search fail: ' + error.message)); return; }
  if (!data.length) { list.replaceChildren(emptyNote('No students found.')); return; }
  list.innerHTML = data.map((p) => `
    <div class="friend-suggestion-item" data-id="${esc(p.id)}">
      <div class="av ${colorFor(p.id)}">${esc(initialsOf(p.full_name))}</div>
      <div class="f-name-wrap"><strong>${esc(p.full_name)}</strong><span>${esc(p.roll_no || '')}${p.branch ? ' | ' + esc(p.branch) : ''}</span></div>
      <div class="select-check"><i class="fas fa-check"></i></div>
    </div>`).join('');
  list._results = new Map(data.map((p) => [p.id, p]));
}

function renderGroupChips() {
  const box = $('groupSelectedChips');
  box.replaceChildren(...[...selectedGroupMembers.values()].map((p) => {
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.append(document.createTextNode(p.full_name || p.roll_no || 'Member'));
    const remove = document.createElement('i'); remove.className = 'fas fa-xmark'; remove.setAttribute('role', 'button');
    remove.setAttribute('aria-label', `Remove ${p.full_name || 'member'}`);
    remove.addEventListener('click', () => { selectedGroupMembers.delete(p.id); renderGroupChips(); renderGroupSearchResults(); });
    chip.appendChild(remove); return chip;
  }));
}

function renderGroupSearchResults() {
  const list = $('groupFriendList');
  const results = list._results;
  if (!results?.size) return;
  list.innerHTML = [...results.values()].map((p) => `
    <div class="friend-suggestion-item${selectedGroupMembers.has(p.id) ? ' selected' : ''}" data-group-id="${esc(p.id)}">
      <div class="av ${colorFor(p.id)}">${esc(initialsOf(p.full_name))}</div>
      <div class="f-name-wrap"><strong>${esc(p.full_name)}</strong><span>${esc(p.roll_no || '')}${p.branch ? ' | ' + esc(p.branch) : ''}</span></div>
      <div class="select-check"><i class="fas fa-check"></i></div>
    </div>`).join('');
}

async function searchGroupPeople(raw) {
  const list = $('groupFriendList');
  const q = sanitizeQ(raw);
  if (q.length < 2) { list._results = new Map(); list.replaceChildren(emptyNote('Enter a name to search for members.')); return; }
  const { data, error } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,public_key').neq('id', S.me)
    .not('public_key', 'is', null).or(`full_name.ilike.%${q}%,roll_no.ilike.%${q}%`).limit(30);
  if (error) { list._results = new Map(); list.replaceChildren(emptyNote('Members search fail: ' + error.message)); return; }
  list._results = new Map((data || []).map((p) => [p.id, p]));
  if (!list._results.size) { list.replaceChildren(emptyNote('No matching members found.')); return; }
  renderGroupSearchResults();
}

async function createGroup() {
  const name = $('groupNameInput').value.trim();
  const memberIds = [...selectedGroupMembers.keys()];
  if (!S.priv) { toast('Unlock the chat before creating an encrypted group.', 'fa-lock'); return; }
  if (!name || name.length > 60) { toast('Enter a group name between 1 and 60 characters.', 'fa-triangle-exclamation'); return; }
  if (!memberIds.length) { toast('Select at least one group member.', 'fa-user-plus'); return; }

  const button = $('createGroupSubmit'); button.disabled = true;
  try {
    const { data: cid, error: createError } = await supabase.rpc('create_group', {
      p_name: name, p_member_ids: memberIds
    });
    if (createError) throw createError;
    const userIds = [S.me, ...memberIds];
    const profiles = await fetchProfiles(userIds);
    if (userIds.some((id) => !profiles.get(id)?.public_key)) throw new Error('A group member is missing an encryption key.');

    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const encodedKey = toB64(rawKey);
    const groupKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const ciphertexts = [], ivs = [];
    for (const userId of userIds) {
      const wrappingKey = await getConversationKey(`${cid}:group`, S.priv, profiles.get(userId).public_key);
      const envelope = await encryptPayload(wrappingKey, { t: 'group-key', key: encodedKey });
      ciphertexts.push(envelope.ciphertext); ivs.push(envelope.iv);
    }
    const { error: keyError } = await supabase.rpc('save_group_key_envelopes', {
      p_conversation_id: cid, p_user_ids: userIds, p_ciphertexts: ciphertexts, p_ivs: ivs
    });
    if (keyError) throw keyError;
    const { data: row, error: rowError } = await supabase.from('conversations').select('*').eq('id', cid).single();
    if (rowError) throw rowError;
    const members = userIds.map((id) => ({ ...profiles.get(id), role: id === S.me ? 'admin' : 'member' }));
    const c = upsertConv(row, profiles, members);
    c.groupKey = groupKey;
    c.groupKeyRaw = rawKey;
    c.groupKeyVersion = Number(row.group_key_version) || 1;
    c.groupKeys.set(c.groupKeyVersion, groupKey);
    c.groupKeyRaws.set(c.groupKeyVersion, rawKey);
    await refreshGroupMembers(c);
    c.preview = null;
    selectedGroupMembers.clear();
    $('groupNameInput').value = ''; $('groupSearchInput').value = '';
    $('groupFriendList')._results = new Map();
    $('groupFriendList').replaceChildren(emptyNote('Enter a name to search for members.'));
    renderGroupChips();
    $('createModal').classList.remove('show');
    document.querySelector('.tab-btn[data-tab="groups"]').click();
    renderLists();
    openConv(c.id);
    toast('Encrypted group created.', 'fa-users');
  } catch (error) {
    console.error('Group create failed:', error);
    toast('Unable to create group: ' + (error.message || error), 'fa-triangle-exclamation');
  } finally { button.disabled = false; }
}

/* ====================== group info / admin controls ====================== */
function groupAdmin(c) {
  return Boolean(c?.isGroup && c.members.some((member) => member.id === S.me && member.role === 'admin'));
}

function renderGroupMemberRows(c) {
  const box = $('groupMemberRows');
  if (!c?.members?.length) {
    box.replaceChildren(emptyNote('Unable to load the member list.')); return;
  }
  const members = [...c.members].sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1)
    || (a.full_name || '').localeCompare(b.full_name || ''));
  box.innerHTML = members.map((member) => {
    const isAdmin = member.role === 'admin';
    const controls = groupAdmin(c) && member.id !== S.me
      ? `<button class="group-role-btn" type="button" data-role-group-member="${esc(member.id)}" data-next-role="${isAdmin ? 'member' : 'admin'}">${isAdmin ? 'Make member' : 'Make admin'}</button>
        ${!isAdmin ? `<button class="remove-member-btn" type="button" data-remove-group-member="${esc(member.id)}" title="Remove member" aria-label="Remove ${esc(member.full_name)}"><i class="fas fa-user-minus"></i></button>` : ''}`
      : '';
    return `<div class="member-row">
      <div class="av ${colorFor(member.id)}">${esc(initialsOf(member.full_name))}</div>
      <div class="m-info"><strong>${esc(member.full_name || 'Unknown member')}${member.id === S.me ? ' (You)' : ''}</strong>
        <span class="${isAdmin ? 'admin-tag' : ''}">${isAdmin ? 'Admin' : 'Member'}${member.roll_no ? ' | ' + esc(member.roll_no) : ''}</span></div>
      ${controls}
    </div>`;
  }).join('');
  $('groupMemberCount').textContent = `${c.members.length} / 100`;
}

function openGroupInfo(c = cur()) {
  if (!c?.isGroup) return;
  $('membersGroupTitle').textContent = c.groupName || 'Group info';
  const isAdmin = groupAdmin(c);
  membersGroupHint.textContent = isAdmin ? 'Admin - manage members and group' : 'Group members and admin details';
  $('groupMemberAddPanel').style.display = isAdmin ? 'block' : 'none';
  $('deleteGroupButton').style.display = isAdmin ? 'inline-flex' : 'none';
  $('groupDeleteNote').style.display = isAdmin ? 'block' : 'none';
  $('groupMemberSearchInput').value = '';
  $('groupMemberSearchResults').replaceChildren(emptyNote('Enter at least two letters of a name or roll number.'));
  $('groupMemberSearchResults')._results = new Map();
  renderGroupMemberRows(c);
  $('membersModal').classList.add('show');
}

function forgetGroupLocally(c) {
  if (!c) return;
  S.convs.delete(c.id);
  c.groupKeys?.clear(); c.groupKeyRaws?.clear(); c.groupKeyPromises?.clear();
  c.groupKey = null; c.groupKeyRaw = null;
  c.archiveFiles = null; c.messages = []; c.ids?.clear();
  muted.delete(c.id); saveMuted();
  if (S.current === c.id) {
    S.current = null;
    $('membersModal').classList.remove('show');
    renderChatWindow();
    closeMobilePane();
  }
  renderLists();
}

const pendingGroupExitIds = new Set();
async function leaveGroup(c = cur()) {
  if (!c?.isGroup || !c.members.some((member) => member.id === S.me)) return;
  const remaining = c.members.filter((member) => member.id !== S.me);
  const lastMember = remaining.length === 0;
  const prompt = lastMember
    ? `You are the last member of ${c.groupName}. Leaving will delete the group and its messages and archive index from Supabase. Existing Cloudinary archive files will remain. Continue?`
    : `Leave "${c.groupName}"? The encryption key for future messages will be rotated for the remaining members. Copies of messages you already received may remain available to you.`;
  if (!await portalConfirm(prompt, { danger: true, confirmText: 'Leave group' })) return;

  const button = $('leaveGroupButton');
  button.disabled = true;
  try {
    let userIds = [], ciphertexts = [], ivs = [];
    const currentVersion = c.groupKeyVersion;
    if (!lastMember) {
      if (!S.priv) throw new Error('Unlock the chat before leaving so the encryption key can be rotated for the remaining members.');
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const encodedKey = toB64(rawKey);
      userIds = remaining.map((member) => member.id);
      for (const member of remaining) {
        if (!member.public_key) throw new Error(`${member.full_name} is missing an encryption key.`);
        const wrappingKey = await getConversationKey(`${c.id}:group`, S.priv, member.public_key);
        const envelope = await encryptPayload(wrappingKey, { t: 'group-key', key: encodedKey });
        ciphertexts.push(envelope.ciphertext); ivs.push(envelope.iv);
      }
    }
    pendingGroupExitIds.add(c.id);
    const { error } = await supabase.rpc('leave_group_with_key', {
      p_conversation_id: c.id,
      p_remaining_user_ids: userIds,
      p_ciphertexts: ciphertexts,
      p_ivs: ivs,
      p_expected_version: currentVersion
    });
    if (error) throw error;
    forgetGroupLocally(c);
    toast(lastMember ? 'You left as the last member. The group was deleted.' : 'You left the group. The encryption key was rotated for the remaining members.', 'fa-right-from-bracket');
  } catch (error) {
    console.error('Leave group failed:', error);
    toast('Unable to leave group: ' + (error.message || error), 'fa-triangle-exclamation');
  } finally { pendingGroupExitIds.delete(c.id); button.disabled = false; }
}

async function deleteGroup(c = cur()) {
  if (!c?.isGroup || !groupAdmin(c)) return;
  const prompt = `Permanently delete "${c.groupName}" for everyone? Its live messages and archive index will be deleted from Supabase. Existing Cloudinary backup files will remain.`;
  if (!await portalConfirm(prompt, { danger: true, confirmText: 'Delete group' })) return;
  const button = $('deleteGroupButton');
  button.disabled = true;
  try {
    pendingGroupExitIds.add(c.id);
    const { error } = await supabase.rpc('delete_group', { p_conversation_id: c.id });
    if (error) throw error;
    forgetGroupLocally(c);
    toast('The group and its chat data were deleted from Supabase.', 'fa-trash-can');
  } catch (error) {
    console.error('Delete group failed:', error);
    toast('Unable to delete group: ' + (error.message || error), 'fa-triangle-exclamation');
  } finally { pendingGroupExitIds.delete(c.id); button.disabled = false; }
}

async function refreshGroupMembers(c) {
  const { data, error } = await supabase.from('group_members')
    .select('conversation_id,user_id,role,joined_at').eq('conversation_id', c.id);
  if (error) throw error;
  if (!data?.some((member) => member.user_id === S.me)) return false;
  const profiles = await fetchProfiles(data.map((member) => member.user_id));
  c.members = data.map((member) => ({
    ...(profiles.get(member.user_id) || { id: member.user_id, full_name: 'Unknown member' }),
    role: member.role, joined_at: member.joined_at
  }));
  c.myJoinedAt = c.members.find((member) => member.id === S.me)?.joined_at || null;
  return true;
}

let groupMemberSearchTimer = null;
async function searchGroupAddPeople(raw) {
  const list = $('groupMemberSearchResults');
  const c = cur();
  const q = sanitizeQ(raw);
  if (!c?.isGroup || !groupAdmin(c)) return;
  if (q.length < 2) {
    list._results = new Map(); list.replaceChildren(emptyNote('Enter at least two letters of a name or roll number.')); return;
  }
  const { data, error } = await supabase.from('profiles')
    .select('id,full_name,roll_no,branch,year,public_key').neq('id', S.me)
    .not('public_key', 'is', null).or(`full_name.ilike.%${q}%,roll_no.ilike.%${q}%`).limit(30);
  if (error) { list._results = new Map(); list.replaceChildren(emptyNote('Search fail: ' + error.message)); return; }
  const existing = new Set(c.members.map((member) => member.id));
  list._results = new Map((data || []).filter((profile) => !existing.has(profile.id)).map((profile) => [profile.id, profile]));
  if (!list._results.size) { list.replaceChildren(emptyNote('No new matching members found.')); return; }
  list.innerHTML = [...list._results.values()].map((profile) => `
    <div class="friend-suggestion-item" data-add-group-member="${esc(profile.id)}">
      <div class="av ${colorFor(profile.id)}">${esc(initialsOf(profile.full_name))}</div>
      <div class="f-name-wrap"><strong>${esc(profile.full_name)}</strong><span>${esc(profile.roll_no || '')}${profile.branch ? ' | ' + esc(profile.branch) : ''}</span></div>
      <div class="select-check"><i class="fas fa-plus"></i></div>
    </div>`).join('');
}

async function addGroupMember(c, profile) {
  if (!groupAdmin(c) || !S.priv) { toast('Sign in as a group admin and unlock the chat to add members.', 'fa-lock'); return; }
  if (c.members.length >= 100) { toast('Groups can have a maximum of 100 members.', 'fa-triangle-exclamation'); return; }
  const list = $('groupMemberSearchResults');
  list.style.pointerEvents = 'none'; list.style.opacity = '.55';
  try {
    const keyVersion = c.groupKeyVersion;
    await keyFor(c, keyVersion);
    const rawKey = c.groupKeyRaws.get(keyVersion);
    if (!rawKey) throw new Error('The group key is unavailable. Reload the chat and try again.');
    if (!profile.public_key) throw new Error('This member has not set up an encryption key.');
    const wrappingKey = await getConversationKey(`${c.id}:group`, S.priv, profile.public_key);
    const envelope = await encryptPayload(wrappingKey, { t: 'group-key', key: toB64(rawKey) });
    const { error } = await supabase.rpc('add_group_member_with_key', {
      p_conversation_id: c.id, p_user_id: profile.id,
      p_ciphertext: envelope.ciphertext, p_iv: envelope.iv, p_key_version: keyVersion
    });
    if (error) throw error;
    await refreshGroupMembers(c);
    renderGroupMemberRows(c); renderChatWindow(); renderLists();
    $('groupMemberSearchInput').value = '';
    list.replaceChildren(emptyNote('Member added. Search for another member.'));
    list._results = new Map();
    toast(`${profile.full_name} was added to the group.`, 'fa-user-plus');
  } catch (error) {
    console.error('Add group member failed:', error);
    toast('Unable to add member: ' + (error.message || error), 'fa-triangle-exclamation');
  } finally { list.style.pointerEvents = ''; list.style.opacity = ''; }
}

async function removeGroupMember(c, memberId) {
  if (!groupAdmin(c) || !S.priv) { toast('Only an unlocked group admin can remove members.', 'fa-lock'); return; }
  const member = c.members.find((item) => item.id === memberId);
  if (!member || member.role === 'admin') return;
  if (!await portalConfirm(`Remove ${member.full_name} from the group? The group encryption key will be rotated for future messages.`, { danger: true, confirmText: 'Remove member' })) return;
  const box = $('groupMemberRows'); box.style.pointerEvents = 'none'; box.style.opacity = '.55';
  try {
    const currentVersion = c.groupKeyVersion;
    const nextVersion = currentVersion + 1;
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const encodedKey = toB64(rawKey);
    const remaining = c.members.filter((item) => item.id !== memberId);
    const userIds = remaining.map((item) => item.id);
    const ciphertexts = [], ivs = [];
    for (const recipient of remaining) {
      if (!recipient.public_key) throw new Error(`${recipient.full_name} is missing an encryption key.`);
      const wrappingKey = await getConversationKey(`${c.id}:group`, S.priv, recipient.public_key);
      const envelope = await encryptPayload(wrappingKey, { t: 'group-key', key: encodedKey });
      ciphertexts.push(envelope.ciphertext); ivs.push(envelope.iv);
    }
    const { error } = await supabase.rpc('remove_group_member_with_key', {
      p_conversation_id: c.id, p_user_id: memberId,
      p_remaining_user_ids: userIds, p_ciphertexts: ciphertexts, p_ivs: ivs,
      p_expected_version: currentVersion
    });
    if (error) throw error;

    c.groupKeyVersion = nextVersion;
    c.groupKeyRaw = rawKey;
    c.groupKeyRaws.set(nextVersion, rawKey);
    c.groupKeys.set(nextVersion, await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']));
    c.groupKey = c.groupKeys.get(nextVersion);
    await refreshGroupMembers(c);
    renderGroupMemberRows(c); renderChatWindow(); renderLists();
    toast(`${member.full_name} was removed. The key for new messages was rotated.`, 'fa-user-minus');
  } catch (error) {
    console.error('Remove group member failed:', error);
    toast('Unable to remove member: ' + (error.message || error), 'fa-triangle-exclamation');
  } finally { box.style.pointerEvents = ''; box.style.opacity = ''; }
}

async function setGroupMemberRole(c, memberId, role) {
  if (!groupAdmin(c) || memberId === S.me) return;
  try {
    const { error } = await supabase.rpc('set_group_member_role', {
      p_conversation_id: c.id, p_user_id: memberId, p_role: role
    });
    if (error) throw error;
    await refreshGroupMembers(c);
    renderGroupMemberRows(c); renderChatWindow(); renderLists();
    const member = c.members.find((item) => item.id === memberId);
    toast(`${member?.full_name || 'Member'} ko ${role === 'admin' ? 'admin' : 'member'} bana diya`, 'fa-user-shield');
  } catch (error) {
    toast('Unable to update role: ' + (error.message || error), 'fa-triangle-exclamation');
  }
}

async function onGroupMembersChange(payload) {
  const row = payload.new?.conversation_id ? payload.new : payload.old;
  if (!row?.conversation_id) return;
  let c = S.convs.get(row.conversation_id);
  if (!c) {
    const { data: conversation } = await supabase.from('conversations').select('*').eq('id', row.conversation_id).maybeSingle();
    if (!conversation?.is_group) return;
    await onConvChange(conversation, false);
    c = S.convs.get(row.conversation_id);
    if (!c) return;
  }
  try {
    const isStillMember = await refreshGroupMembers(c);
    if (!isStillMember) {
      const { data: conversation } = await supabase.from('conversations').select('id').eq('id', c.id).maybeSingle();
      const localExit = pendingGroupExitIds.has(c.id);
      forgetGroupLocally(c);
      if (!localExit) toast(conversation ? 'You were removed from the group.' : 'The group admin deleted the group.', conversation ? 'fa-user-minus' : 'fa-trash-can');
      return;
    }
    renderLists();
    if (S.current === c.id) {
      renderChatWindow();
      if ($('membersModal').classList.contains('show')) {
        $('groupMemberAddPanel').style.display = groupAdmin(c) ? 'block' : 'none';
        const isAdmin = groupAdmin(c);
  membersGroupHint.textContent = isAdmin ? 'Admin - manage members and group' : 'Group members and admin details';
        $('deleteGroupButton').style.display = isAdmin ? 'inline-flex' : 'none';
        $('groupDeleteNote').style.display = isAdmin ? 'block' : 'none';
        renderGroupMemberRows(c);
      }
    }
  } catch (error) { console.error('Group membership refresh failed:', error.message); }
}

function onConversationDelete(payload) {
  const id = payload.old?.id;
  const c = id && S.convs.get(id);
  if (!c?.isGroup) return;
  const localExit = pendingGroupExitIds.has(id);
  forgetGroupLocally(c);
  if (!localExit) toast('The group admin deleted the group.', 'fa-trash-can');
}

async function startChatWith(profile) {
  const { data: cid, error } = await supabase.rpc('start_conversation', { p_other: profile.id });
  if (error) { toast(error.message, 'fa-triangle-exclamation'); return; }
  const { data: row } = await supabase.from('conversations').select('*').eq('id', cid).single();
  const c = upsertConv(row, new Map([[profile.id, profile]]));
  if (c.status === 'rejected') { toast('This request has already been declined.', 'fa-ban'); return; }
  $('createModal').classList.remove('show');
  const incoming = c.status === 'pending' && c.requestedBy !== S.me;
  document.querySelector(`.tab-btn[data-tab="${incoming ? 'requests' : 'chats'}"]`).click();
  renderLists();
  openConv(c.id);
  if (!incoming && c.status === 'pending' && !c.loaded) toast('Request sent. You can send up to three messages while you wait for acceptance.', 'fa-paper-plane');
}

/* ====================== wiring ====================== */
function wireUI() {
  let viewportSyncFrame = 0;
  const syncVisualViewport = () => {
    if (viewportSyncFrame) return;
    viewportSyncFrame = requestAnimationFrame(() => {
      viewportSyncFrame = 0;
      const viewport = window.visualViewport;
      if (!viewport || !window.matchMedia('(max-width: 900px)').matches) return;
      const root = document.documentElement;
      const height = `${Math.round(viewport.height)}px`;
      const top = `${Math.round(viewport.offsetTop)}px`;
      if (root.style.getPropertyValue('--visual-vh') !== height) root.style.setProperty('--visual-vh', height);
      if (root.style.getPropertyValue('--visual-top') !== top) root.style.setProperty('--visual-top', top);
    });
  };
  syncVisualViewport();
  window.addEventListener('resize', syncVisualViewport, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncVisualViewport, { passive: true });
  }
  setInterval(() => {
    const c = cur();
    if (c?.loaded && document.visibilityState === 'visible') refreshOutgoingReceipts(c);
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { markCurrentRead(); refreshOutgoingReceipts(cur()); }
  });
  const messagesArea = $('messagesArea');
  messagesArea.addEventListener('scroll', () => {
    const c = cur();
    if (!c) return;
    markCurrentRead();
    // Keyboard/viewport adjustments while composing can move the scroll area;
    // don't mistake that for a deliberate scroll to load older history.
    if (document.activeElement !== $('msgInput') && messagesArea.scrollTop < 80) void loadOlder(c);
  }, { passive: true });
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
  $('tab-groups').addEventListener('click', (e) => {
    if (e.target.closest('#groupCreateButton')) return;
    const item = e.target.closest('.chat-item');
    const c = item && S.convs.get(item.dataset.id);
    if (c?.isGroup) openConv(c.id);
  });
  $('hdrGroupLink').addEventListener('click', (e) => { e.preventDefault(); openGroupInfo(); });
  $('viewProfileBtn').addEventListener('click', () => openContactProfile());
  const closeContactProfile = () => {
    contactProfileRequest++;
    $('contactProfileModal').classList.remove('show');
  };
  $('closeContactProfile').addEventListener('click', closeContactProfile);
  $('contactProfileModal').addEventListener('click', (event) => {
    if (event.target === $('contactProfileModal')) closeContactProfile();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('contactProfileModal').classList.contains('show')) closeContactProfile();
  });
  $('closeMembersModal').addEventListener('click', () => $('membersModal').classList.remove('show'));
  $('leaveGroupButton').addEventListener('click', () => leaveGroup());
  $('deleteGroupButton').addEventListener('click', () => deleteGroup());
  $('membersModal').addEventListener('click', (e) => { if (e.target === $('membersModal')) $('membersModal').classList.remove('show'); });
  $('groupMemberSearchInput').addEventListener('input', function () {
    clearTimeout(groupMemberSearchTimer);
    groupMemberSearchTimer = setTimeout(() => searchGroupAddPeople(this.value), 250);
  });
  $('groupMemberSearchResults').addEventListener('click', (e) => {
    const item = e.target.closest('[data-add-group-member]');
    const profile = item && $('groupMemberSearchResults')._results?.get(item.dataset.addGroupMember);
    if (profile && cur()?.isGroup) addGroupMember(cur(), profile);
  });
  $('groupMemberRows').addEventListener('click', (e) => {
    const roleButton = e.target.closest('[data-role-group-member]');
    if (roleButton && cur()?.isGroup) {
      setGroupMemberRole(cur(), roleButton.dataset.roleGroupMember, roleButton.dataset.nextRole);
      return;
    }
    const button = e.target.closest('[data-remove-group-member]');
    if (button && cur()?.isGroup) removeGroupMember(cur(), button.dataset.removeGroupMember);
  });

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
  document.addEventListener('click', (e) => {
    $('moreMenu').classList.remove('show');
    if (!e.target.closest('.message-actions')) {
      document.querySelectorAll('.message-action-popover.show').forEach((menu) => menu.classList.remove('show'));
      document.querySelectorAll('.msg-row.context-open').forEach((row) => row.classList.remove('context-open'));
    }
  });
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
    if (act === 'profile') openContactProfile(c);
    if (act === 'block') toggleBlock(c);
    if (act === 'report') reportChat(c);
    if (act === 'clear') clearChat(c);
    $('moreMenu').classList.remove('show');
  });

  const closeEditModal = () => { $('messageEditModal').classList.remove('show'); pendingMessageEdit = null; };
  $('messageEditClose').addEventListener('click', closeEditModal);
  $('messageEditCancel').addEventListener('click', closeEditModal);
  $('messageEditModal').addEventListener('click', (e) => { if (e.target === $('messageEditModal')) closeEditModal(); });
  $('messageEditSave').addEventListener('click', saveEditedMessage);
  const closeDeleteModal = () => { $('messageDeleteModal').classList.remove('show'); pendingMessageDelete = null; };
  $('messageDeleteClose').addEventListener('click', closeDeleteModal);
  $('messageDeleteCancel').addEventListener('click', closeDeleteModal);
  $('messageDeleteModal').addEventListener('click', (e) => { if (e.target === $('messageDeleteModal')) closeDeleteModal(); });
  $('messageDeleteConfirm').addEventListener('click', confirmDeleteMessage);
  $('replyComposerCancel').addEventListener('click', () => clearReplyTarget());
  $('clearAttachmentDraft').addEventListener('click', clearAttachmentDraft);
  $('attachmentDraftItems').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-draft]');
    if (button) removeAttachmentDraft(Number(button.dataset.removeDraft));
  });

  // composer
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComposer(); });
  document.querySelector('.send-btn').addEventListener('click', sendComposer);
  const attachmentMenu = $('attachmentMenu');
  const attachButton = $('attachButton');
  const closeAttachmentMenu = () => {
    attachmentMenu.hidden = true;
    attachButton.setAttribute('aria-expanded', 'false');
  };
  attachButton.addEventListener('click', () => {
    attachmentMenu.hidden = !attachmentMenu.hidden;
    attachButton.setAttribute('aria-expanded', String(!attachmentMenu.hidden));
  });
  $('mobileCameraButton').addEventListener('click', () => $('cameraInput').click());
  attachmentMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-picker]');
    if (!option) return;
    const inputId = { document: 'fileInput', gallery: 'galleryInput', camera: 'cameraInput' }[option.dataset.picker];
    closeAttachmentMenu();
    if (inputId) $(inputId).click();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#attachmentPicker')) closeAttachmentMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !attachmentMenu.hidden) {
      closeAttachmentMenu();
      attachButton.focus();
    }
  });
  ['fileInput', 'galleryInput', 'cameraInput'].forEach((inputId) => {
    $(inputId).addEventListener('change', function () {
      const files = Array.from(this.files || []);
      this.value = '';
      addAttachmentDraft(files);
    });
  });

  // infinite scroll up -> live table, phir Cloudinary archive
  // mobile back
  $('backToListBtn').addEventListener('click', () => {
    if (history.state && history.state.mgmChatOpen) history.back(); else closeMobilePane();
  });
  window.addEventListener('popstate', () => {
    if ($('attachmentViewer')?.classList.contains('show')) {
      closeAttachmentViewer(true);
      return;
    }
    closeMobilePane();
  });

  // search in list
  $('searchInput').addEventListener('input', applySearchFilter);

  // new chat modal
  const selectCreatePane = (tab) => {
    document.querySelectorAll('.create-tab-btn').forEach((button) => button.classList.toggle('active', button.dataset.ctab === tab));
    $('createPane-chat').style.display = tab === 'chat' ? 'block' : 'none';
    $('createPane-group').style.display = tab === 'group' ? 'block' : 'none';
  };
  document.querySelectorAll('.create-tab-btn').forEach((button) => button.addEventListener('click', () => selectCreatePane(button.dataset.ctab)));
  const closeMobileCreateMenu = () => {
    $('mobileCreateActions').classList.remove('show');
    $('mobileCreateActions').setAttribute('aria-hidden', 'true');
    $('mobileCreateFab').setAttribute('aria-expanded', 'false');
  };
  const openCreateModal = (tab) => {
    closeMobileCreateMenu();
    selectCreatePane(tab);
    if (tab === 'chat') {
      $('ncSearch').value = '';
      $('ncFriendList').replaceChildren(emptyNote('Enter at least two letters of a name or roll number.'));
      $('createModal').classList.add('show');
      setTimeout(() => $('ncSearch').focus(), 50);
      return;
    }
    $('groupSearchInput').value = '';
    $('groupNameInput').value = '';
    selectedGroupMembers.clear(); renderGroupChips();
    $('groupFriendList')._results = new Map();
    $('groupFriendList').replaceChildren(emptyNote('Enter a name to search for members.'));
    $('createModal').classList.add('show');
    setTimeout(() => $('groupNameInput').focus(), 50);
  };
  $('newChatBtn').addEventListener('click', () => openCreateModal('chat'));
  $('groupCreateButton').addEventListener('click', () => openCreateModal('group'));
  $('mobileCreateFab').addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = !$('mobileCreateActions').classList.contains('show');
    $('mobileCreateActions').classList.toggle('show', opening);
    $('mobileCreateActions').setAttribute('aria-hidden', String(!opening));
    $('mobileCreateFab').setAttribute('aria-expanded', String(opening));
  });
  $('mobileCreateActions').addEventListener('click', (event) => {
    const action = event.target.closest('[data-mobile-create]')?.dataset.mobileCreate;
    if (action) openCreateModal(action);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#mobileCreateFab, #mobileCreateActions')) closeMobileCreateMenu();
  });
  $('closeCreateModal').addEventListener('click', () => $('createModal').classList.remove('show'));
  $('createModal').addEventListener('click', (e) => { if (e.target === $('createModal')) $('createModal').classList.remove('show'); });
  $('ncSearch').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchPeople(this.value), 250);
  });
  $('groupSearchInput').addEventListener('input', function () {
    clearTimeout(groupSearchTimer);
    groupSearchTimer = setTimeout(() => searchGroupPeople(this.value), 250);
  });
  $('groupFriendList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-group-id]');
    const profile = item && $('groupFriendList')._results?.get(item.dataset.groupId);
    if (!profile) return;
    if (selectedGroupMembers.has(profile.id)) selectedGroupMembers.delete(profile.id);
    else if (selectedGroupMembers.size < 99) selectedGroupMembers.set(profile.id, profile);
    else toast('Groups can have a maximum of 100 members.', 'fa-triangle-exclamation');
    renderGroupChips(); renderGroupSearchResults();
  });
  $('createGroupSubmit').addEventListener('click', createGroup);
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
  const checkArchives = () => S.convs.forEach((conversation) => { void archiveOverflow(conversation); });
  window.setInterval(checkArchives, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkArchives();
  });
  if (!S.priv) toast('Chat locked: open it to unlock.', 'fa-lock');
  loadPreviews().then(renderLists).catch(() => {});
}

const session = await requireAuth();
if (session) init(session.user.id);
