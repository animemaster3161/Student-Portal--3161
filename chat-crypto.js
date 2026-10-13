// chat-crypto.js -- message + attachment encryption (AES-GCM)
// Conversation key = ECDH(meri private key, uska public key) -> dono taraf same AES key.
import { deriveSharedKey } from './e2ee.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ---------- conversation key ---------- */
const keyCache = new Map();

export async function getConversationKey(convId, myPrivateKey, theirPublicJwk) {
  const cacheKey = convId + ':' + (theirPublicJwk?.x || '');
  if (!keyCache.has(cacheKey)) {
    if (!theirPublicJwk) throw new Error('NO_PEER_KEY');
    keyCache.set(cacheKey, await deriveSharedKey(myPrivateKey, theirPublicJwk));
  }
  return keyCache.get(cacheKey);
}

/* ---------- text / payload ---------- */
// payload: { t:'text', text } ya { t:'file', text, file:{url,key,iv,name,size,mime} }
export async function encryptPayload(aesKey, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(payload)));
  return { ciphertext: toB64(ct), iv: toB64(iv) };
}

export async function decryptPayload(aesKey, { ciphertext, iv }) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, aesKey, fromB64(ciphertext));
  return JSON.parse(dec.decode(pt));
}

/* ---------- attachments ---------- */
// File ko browser me hi encrypt karte hain. Cloudinary par sirf ciphertext jaata hai;
// file ki key + iv message ke encrypted payload ke andar jaati hai.
export async function encryptFile(file) {
  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, await file.arrayBuffer());
  const raw = await crypto.subtle.exportKey('raw', fileKey);
  return {
    blob: new Blob([ct], { type: 'application/octet-stream' }),
    key: toB64(raw),
    iv: toB64(iv)
  };
}

export async function decryptFile({ url, key, iv, mime }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('FILE_FETCH_FAILED');
  const ct = await res.arrayBuffer();
  const fileKey = await crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, fileKey, ct);
  return new Blob([pt], { type: mime || 'application/octet-stream' });
}
