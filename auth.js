// auth.js -- Module A: Authentication & User Persistence
import { supabase } from './supabase-config.js';
import {
  createIdentity, restoreIdentity,
  getLocalPrivateKey, saveLocalPrivateKey, wipeLocalKeys
} from './e2ee.js';

export { supabase };

const LOGIN_PAGE = 'login.html';
const HOME_PAGE  = 'index.html';

/* ============ Session ============ */

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Protected pages (index.html + iframe pages) me sabse upar call karo. */
export async function requireAuth() {
  const session = await getSession();
  if (!session) { goToLogin(); return null; }

  // Kisi bhi tab/device se sign-out ho to yahan bhi bahar
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') goToLogin();
  });
  return session;
}

/** login.html / signup.html par: pehle se logged-in ho to seedha portal. */
export async function redirectIfLoggedIn() {
  if (await getSession()) window.location.replace(HOME_PAGE);
}

function goToLogin() {
  // iframe ke andar ho to poora window login par le jao
  (window.top || window).location.replace(LOGIN_PAGE);
}

/* ============ Sign up ============ */

export async function signUp({ name, email, password, keyword, roll, branch, year, semester }) {
  if (!keyword || keyword.trim().length < 6) {
    throw new Error('Security keyword kam se kam 6 characters ka rakho.');
  }

  // Keys signup par hi ban jaati hain, kyunki keyword abhi hamare paas hai
  const identity = await createIdentity(keyword);

  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: {
        full_name: name.trim(),
        roll_no: roll.trim(),
        branch, year, semester,
        public_key: identity.publicJwk,   // DB trigger isse profiles me daalta hai
        key_backup: identity.backup       // DB trigger isse key_backups me daalta hai (encrypted)
      }
    }
  });
  if (error) throw error;

  // Email pehle se registered ho to Supabase error nahi deta, identities khaali aati hai
  if (data.user && data.user.identities?.length === 0) {
    throw new Error('Ye email pehle se registered hai.');
  }

  if (data.user) await saveLocalPrivateKey(data.user.id, identity.privateKey);

  // session null => email confirmation ON hai
  return { needsEmailConfirm: !data.session };
}

/* ============ Sign in ============ */

async function resolveEmail(idOrEmail) {
  const v = idOrEmail.trim();
  if (v.includes('@')) return v.toLowerCase();
  const { data, error } = await supabase.rpc('email_for_roll', { p_roll: v });
  if (error || !data) throw new Error('Invalid roll number/email or password.');
  return data;
}

/**
 * askKeyword(attempt) -> Promise<string|null>
 * Naye device par keyword maangne ke liye. null return karo to user ne cancel kiya.
 */
export async function signIn({ id, password, askKeyword = defaultAskKeyword }) {
  const email = await resolveEmail(id);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid roll number/email or password.');

  const keyReady = await ensureIdentity(data.user, askKeyword);
  return { user: data.user, e2eeReady: keyReady };
}

function defaultAskKeyword(attempt) {
  const msg = attempt === 0
    ? 'Naya device mila. Chat unlock karne ke liye apna Security Keyword daalo:'
    : 'Keyword galat hai. Dobara try karo:';
  return Promise.resolve(window.prompt(msg));
}

/* ============ E2EE identity (login ke baad) ============ */

async function ensureIdentity(user, askKeyword) {
  // 1) Is browser me private key pehle se hai -> kuch nahi karna
  if (await getLocalPrivateKey(user.id)) { await cleanupSignupMetadata(user); return true; }

  // 2) Server par backup hai (naya device / browser data clear) -> keyword se restore
  const { data: backup } = await supabase
    .from('key_backups').select('*').eq('user_id', user.id).maybeSingle();

  if (backup) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const keyword = await askKeyword(attempt);
      if (!keyword) return false;                       // cancel
      try {
        const key = await restoreIdentity(backup, keyword);
        await saveLocalPrivateKey(user.id, key);
        await cleanupSignupMetadata(user);
        return true;
      } catch { /* wrong keyword -> loop */ }
    }
    return false;
  }

  // 3) Na local key, na backup (rare) -> fresh identity, keyword maango
  const keyword = await askKeyword(0);
  if (!keyword) return false;
  const identity = await createIdentity(keyword);
  await supabase.from('profiles').update({ public_key: identity.publicJwk }).eq('id', user.id);
  await supabase.from('key_backups').upsert({ user_id: user.id, ...identity.backup });
  await saveLocalPrivateKey(user.id, identity.privateKey);
  return true;
}

// Signup ke time metadata me rakha encrypted backup ab DB me hai, auth metadata se hata do
async function cleanupSignupMetadata(user) {
  if (user.user_metadata?.key_backup) {
    await supabase.auth.updateUser({ data: { key_backup: null, public_key: null } });
  }
}

/* ============ Sign out ============ */

/** wipeKeys=true: shared/public computer par private key bhi browser se hata do. */
export async function signOut({ wipeKeys = false } = {}) {
  const session = await getSession();
  if (wipeKeys && session) await wipeLocalKeys(session.user.id);
  await supabase.auth.signOut();               // sirf ye device
  goToLogin();
}

/** Settings -> "Force Logout Everywhere" */
export async function signOutEverywhere() {
  await supabase.auth.signOut({ scope: 'global' });
  goToLogin();
}

/* ============ Profile (setting_account.html) ============ */

export async function loadProfile() {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', session.user.id).single();
  if (error) throw error;
  return data;
}

export async function saveProfile({ full_name, bio, personal_email }) {
  const session = await getSession();
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: full_name.trim(), bio: bio.trim(), personal_email: personal_email.trim() })
    .eq('id', session.user.id);
  if (error) throw error;
}

/* ============ Password ============ */

export async function changePassword(currentPassword, newPassword) {
  if (newPassword.length < 6) throw new Error('Naya password kam se kam 6 characters ka ho.');
  const session = await getSession();

  // Current password verify karo
  const { error: reauthErr } = await supabase.auth.signInWithPassword({
    email: session.user.email, password: currentPassword
  });
  if (reauthErr) throw new Error('Current password galat hai.');

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}
