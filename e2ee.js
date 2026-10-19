// e2ee.js
// - ECDH P-256 key pair (chat ke liye shared secret derive hota hai)
// - Private key: IndexedDB me NON-EXTRACTABLE CryptoKey ke roop me (JS se read/export nahi hoti)
// - Server backup: private key is wrapped with the Security Keyword (PBKDF2 -> AES-GCM).
// - Downloadable recovery backup: a second wrap uses the account password, so the file can restore the key after a keyword reset.
//   Both copies contain ciphertext only; passwords and plaintext key stay in the browser.

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
  try { return localStorage.getItem(`${REMEMBER_KEY_PREFIX}${uid}`) === '1'; }
  catch { return false; }
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
  // Keep the chat key on this browser/device until the portal session ends.
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  const result = await idbRun('readwrite', (s) => s.put(key, `priv:${uid}`));
  try { localStorage.setItem(`${REMEMBER_KEY_PREFIX}${uid}`, '1'); } catch { /* ignore */ }
  return result;
};
export async function wipeLocalKeys(uid) {
  try { localStorage.removeItem(`${REMEMBER_KEY_PREFIX}${uid}`); } catch { /* ignore */ }
  return idbRun('readwrite', (s) => s.delete(`priv:${uid}`));
}

/* ---------------- Keyword -> AES wrap key ---------------- */
async function deriveWrapKey(password, salt, iterations, normalizeKeyword = true) {
  const secret = normalizeKeyword
    ? String(password).trim().toLowerCase().normalize('NFKC')
    : String(password);
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapPrivateJwk(privJwk, password, normalizeKeyword = true) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrapKey(password, salt, PBKDF2_ITERATIONS, normalizeKeyword);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    enc.encode(JSON.stringify(privJwk))
  );
  return { wrapped_key: b64(ct), salt: b64(salt), iv: b64(iv), iterations: PBKDF2_ITERATIONS };
}

/* ---------------- Public API ---------------- */

/** New identity: key pair + keyword-wrapped server backup + account-password-wrapped recovery copy. */
export async function createIdentity(keyword, accountPassword = keyword) {
  const pair = await crypto.subtle.generateKey(CURVE, true, KEY_USAGES);
  const privJwk   = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const backup    = await wrapPrivateJwk(privJwk, keyword);
  const recoveryBackup = await wrapPrivateJwk(privJwk, accountPassword, false);

  // Storage ke liye non-extractable copy
  const privateKey = await crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
  return { publicJwk, backup, recoveryBackup, privateKey };
}

/** Backup + keyword se private key wapas. Galat keyword par 'WRONG_KEYWORD' throw. */
export async function restoreIdentity(backup, password, normalizeKeyword = true) {
  const privJwk = await unwrapPrivateJwk(backup, password, normalizeKeyword);
  return crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
}

async function unwrapPrivateJwk(backup, password, normalizeKeyword = true) {
  try {
    if (!backup?.salt || !backup?.iv || !backup?.wrapped_key ||
        !Number.isInteger(backup.iterations) || backup.iterations < 100000 || backup.iterations > 1000000) {
      throw new Error('INVALID_BACKUP');
    }
    const wrapKey = await deriveWrapKey(password, unb64(backup.salt), backup.iterations, normalizeKeyword);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(backup.iv) },
      wrapKey,
      unb64(backup.wrapped_key)
    );
    const privJwk = JSON.parse(dec.decode(plain));
    if (privJwk.kty !== 'EC' || privJwk.crv !== 'P-256' || !privJwk.d) throw new Error('INVALID_BACKUP');
    await crypto.subtle.importKey('jwk', privJwk, CURVE, false, KEY_USAGES);
    return privJwk;
  } catch (e) {
    if (e?.message === 'INVALID_BACKUP') throw e;
    throw new Error('WRONG_KEYWORD');
  }
}

/** Rewrap the same chat identity under a new keyword and account password. */
export async function rewrapRecoveryIdentity(backup, accountPassword, newKeyword) {
  const privJwk = await unwrapPrivateJwk(backup, accountPassword, false);
  return {
    keywordBackup: await wrapPrivateJwk(privJwk, newKeyword),
    recoveryBackup: await wrapPrivateJwk(privJwk, accountPassword, false)
  };
}

/** Make both fresh wrappers after a normal keyword change. */
export async function rewrapIdentityForRecovery(backup, currentKeyword, newKeyword, accountPassword) {
  const privJwk = await unwrapPrivateJwk(backup, currentKeyword);
  return {
    keywordBackup: await wrapPrivateJwk(privJwk, newKeyword),
    recoveryBackup: await wrapPrivateJwk(privJwk, accountPassword, false)
  };
}

/** Refresh only the account-password-encrypted copy after an account password change. */
export async function refreshRecoveryIdentity(backup, currentKeyword, accountPassword) {
  const privJwk = await unwrapPrivateJwk(backup, currentKeyword);
  return {
    keywordBackup: backup,
    recoveryBackup: await wrapPrivateJwk(privJwk, accountPassword, false)
  };
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
