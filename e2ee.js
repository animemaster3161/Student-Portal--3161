// e2ee.js
// - ECDH P-256 key pair (chat ke liye shared secret derive hota hai)
// - Private key: IndexedDB me NON-EXTRACTABLE CryptoKey ke roop me (JS se read/export nahi hoti)
// - Recovery backup: private key ko Security Keyword se encrypt karke (PBKDF2 -> AES-GCM) Supabase me rakhte hain.
//   Server ko sirf encrypted blob dikhta hai, keyword kabhi server tak nahi jaata.

const enc = new TextEncoder();
const dec = new TextDecoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const KEY_USAGES = ['deriveKey', 'deriveBits'];
export const PBKDF2_ITERATIONS = 310000;

const b64   = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s)   => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ---------------- IndexedDB (local private key store) ---------------- */
const DB_NAME = 'mgm_e2ee';
const STORE   = 'keys';
const REMEMBER_KEY_PREFIX = 'mgm_e2ee_remember_';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbRun(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export function isLocalKeyRemembered(uid) {
  try {
    const preference = localStorage.getItem(`${REMEMBER_KEY_PREFIX}${uid}`);
    // Existing signed-in devices keep their current behavior until the user
    // next chooses Remember this device on the login page.
    return preference !== '0';
  } catch { return true; }
}

export async function setLocalKeyRemembered(uid, remember) {
  try { localStorage.setItem(`${REMEMBER_KEY_PREFIX}${uid}`, remember ? '1' : '0'); } catch { /* ignore */ }
  if (!remember) {
    try { await wipeLocalKeys(uid); } catch { /* the current page still has its in-memory key */ }
  }
}

async function readRememberedKey(uid) {
  if (!isLocalKeyRemembered(uid)) return null;
  const stored = await idbRun('readonly', (s) => s.get(`priv:${uid}`));
  if (!stored) return null;
  // Accept the original CryptoKey format and records written during the
  // temporary expiry implementation, without expiring remembered devices.
  return stored.key || stored;
}

export async function getLocalPrivateKey(uid) {
  return (await readRememberedKey(uid)) || null;
}

export const saveLocalPrivateKey = async (uid, key) => {
  // Remember the chat key on this browser/device until the user opts out.
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  return idbRun('readwrite', (s) => s.put(key, `priv:${uid}`));
};
export const wipeLocalKeys       = (uid)      => idbRun('readwrite', (s) => s.delete(`priv:${uid}`));

/* ---------------- Keyword -> AES wrap key ---------------- */
async function deriveWrapKey(keyword, salt, iterations) {
  const norm = keyword.trim().toLowerCase().normalize('NFKC');
  const base = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapPrivateJwk(privJwk, keyword) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrapKey(keyword, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    enc.encode(JSON.stringify(privJwk))
  );
  return { wrapped_key: b64(ct), salt: b64(salt), iv: b64(iv), iterations: PBKDF2_ITERATIONS };
}

/* ---------------- Public API ---------------- */

/** Naya identity: key pair + keyword-encrypted backup. */
export async function createIdentity(keyword) {
  const pair = await crypto.subtle.generateKey(CURVE, true, KEY_USAGES);
  const privJwk   = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const backup    = await wrapPrivateJwk(privJwk, keyword);

  // Storage ke liye non-extractable copy
  const privateKey = await crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
  return { publicJwk, backup, privateKey };
}

/** Backup + keyword se private key wapas. Galat keyword par 'WRONG_KEYWORD' throw. */
export async function restoreIdentity(backup, keyword) {
  try {
    const wrapKey = await deriveWrapKey(keyword, unb64(backup.salt), backup.iterations);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(backup.iv) },
      wrapKey,
      unb64(backup.wrapped_key)
    );
    const privJwk = JSON.parse(dec.decode(plain));
    return await crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
  } catch (e) {
    throw new Error('WRONG_KEYWORD');
  }
}

/** Re-encrypt an existing identity backup under a replacement keyword. */
export async function rewrapIdentityBackup(backup, currentKeyword, newKeyword) {
  let plain;
  try {
    const wrapKey = await deriveWrapKey(currentKeyword, unb64(backup.salt), backup.iterations);
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(backup.iv) },
      wrapKey,
      unb64(backup.wrapped_key)
    );
  } catch {
    throw new Error('WRONG_KEYWORD');
  }

  let privJwk;
  try {
    privJwk = JSON.parse(dec.decode(plain));
    if (privJwk.kty !== 'EC' || privJwk.crv !== 'P-256' || !privJwk.d) throw new Error('Invalid private key');
    await crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
  } catch {
    throw new Error('INVALID_KEY_BACKUP');
  }

  return wrapPrivateJwk(privJwk, newKeyword);
}

/** Chat ke liye: apni private key + doosre ki public JWK -> AES-GCM session key. */
export async function deriveSharedKey(myPrivateKey, theirPublicJwk) {
  const theirPub = await crypto.subtle.importKey('jwk', theirPublicJwk, CURVE, false, []);
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPub },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
