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
 * Login ab kabhi Security Keyword nahi maangta.
 * Is browser me key ho to chat seedha khulti hai; nahi ho to chat ke andar "Unlock" box aata hai.
 */
export async function signIn({ id, password }) {
  const email = await resolveEmail(id);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid roll number/email or password.');

  const e2eeReady = await hasLocalKey(data.user.id);
  if (e2eeReady) await cleanupSignupMetadata(data.user);
  return { user: data.user, e2eeReady };
}

/* ============ E2EE unlock (chat ke andar se) ============ */

export async function hasLocalKey(userId) {
  try { return !!(await getLocalPrivateKey(userId)); } catch { return false; }
}

/**
 * Security Keyword se server backup khol kar private key is browser me save karta hai.
 * Galat keyword par Error('WRONG_KEYWORD'), backup na mile to Error('NO_BACKUP').
 */
export async function unlockWithKeyword(keyword) {
  const session = await getSession();
  if (!session) throw new Error('NOT_LOGGED_IN');
  const user = session.user;

  const { data: backup, error } = await supabase
    .from('key_backups').select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  if (!backup) throw new Error('NO_BACKUP');

  const key = await restoreIdentity(backup, keyword);   // galat keyword -> WRONG_KEYWORD
  await saveLocalPrivateKey(user.id, key);
  try { await cleanupSignupMetadata(user); } catch { /* ignore */ }
  return key;
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
