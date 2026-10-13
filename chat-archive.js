// chat-archive.js -- Archive runner (Node 18+). Cloudflare ki zarurat nahi.
//
// 1) Supabase RPC get_archivable_messages() -> rank > 10 aur 24h se purane (encrypted) messages
// 2) conversation + IST date ke hisaab se raw JSON me pack
// 3) Cloudinary (raw upload, signed)  ->  backups/{conversation_id}/{date}-{run}.json
// 4) Supabase 'chat_archives' me index row
// 5) SABHI upload + index safal hone ke BAAD hi live rows delete
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Run: node chat-archive.js   (GitHub Actions cron se, archive.yml dekho)

import { createHash } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET })) {
  if (!v) { console.error('Missing env: ' + k); process.exit(1); }
}

const IST_MS = 5.5 * 3600 * 1000;
const BATCH = 500;
const MAX_ROUNDS = 40;              // ek run me max 20,000 rows; bacha hua agli baar
const RUN_ID = Date.now().toString(36);

/* ---------- Supabase (service role) ---------- */
async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(init.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------- Cloudinary signed raw upload ---------- */
async function uploadRaw(publicId, jsonString) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`)
    .digest('hex');

  const form = new FormData();
  form.append('file', new Blob([jsonString], { type: 'application/json' }), 'archive.json');
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/raw/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${await res.text()}`);
  return (await res.json()).secure_url;
}

/* ---------- main ---------- */
async function main() {
  let moved = 0, files = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const rows = await sb('rpc/get_archivable_messages', {
      method: 'POST',
      body: JSON.stringify({ p_limit: BATCH, p_keep: 10, p_age: '24 hours' }),
      headers: { Prefer: 'return=representation' }
    });
    if (!rows || !rows.length) break;

    // conversation + IST date ke hisaab se group
    const groups = new Map();
    for (const m of rows) {
      const date = new Date(new Date(m.created_at).getTime() + IST_MS).toISOString().slice(0, 10);
      const key = `${m.conversation_id}|${date}`;
      if (!groups.has(key)) groups.set(key, { conversation_id: m.conversation_id, date, msgs: [] });
      groups.get(key).msgs.push(m);
    }

    // Pehle sab upload + index
    for (const g of groups.values()) {
      const publicId = `backups/${g.conversation_id}/${g.date}-${RUN_ID}-${files}.json`;
      const url = await uploadRaw(publicId, JSON.stringify({
        conversation_id: g.conversation_id, date: g.date, messages: g.msgs
      }));
      await sb('chat_archives', {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: g.conversation_id, archive_date: g.date,
          public_id: publicId, url, message_count: g.msgs.length
        })
      });
      files++;
    }

    // Sab safal -> ab live rows delete
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      await sb(`messages?id=in.(${ids.slice(i, i + 100).join(',')})`, { method: 'DELETE' });
    }
    moved += rows.length;
    if (rows.length < BATCH) break;
  }
  console.log(`archive done: ${moved} messages -> ${files} Cloudinary files`);
}

main().catch((e) => { console.error(e); process.exit(1); });
