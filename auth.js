// auth.js
import { supabase } from './supabase-config.js';
import {
  createIdentity, restoreIdentity,
  rewrapIdentityBackup,
  getLocalPrivateKey, saveLocalPrivateKey, wipeLocalKeys,
  isLocalKeyRemembered, setLocalKeyRemembered
} from './e2ee.js';

const firebaseConfig = {
  apiKey: "AIzaSyDT5PWeMm85EScNPaxU6QoE4VoISPAg4eQ",
  authDomain: "mgm-coet-unoffical.firebaseapp.com",
  projectId: "mgm-coet-unoffical",
};

// Firebase is only used for the optional email-verification check. Load it
// only when that check runs, so a blocked Firebase CDN cannot prevent the
// rest of the portal modules and their button handlers from starting.
let firebaseAuthPromise;
function getFirebaseAuth() {
  if (!firebaseAuthPromise) {
    firebaseAuthPromise = Promise.all([
      import("https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")
    ]).then(([appModule, authModule]) => {
      const app = appModule.getApps().length
        ? appModule.getApp()
        : appModule.initializeApp(firebaseConfig, "authApp");
      return { auth: authModule.getAuth(app), ...authModule };
    }).catch(error => {
      firebaseAuthPromise = null;
      throw error;
    });
  }
  return firebaseAuthPromise;
}

export { supabase };

const APP_URL = 'https://student-omega-fawn.vercel.app';
const PRODUCTION_LOGIN_URL = `${APP_URL}/login.html`;
const LOGIN_PAGE = 'login.html';
const HOME_PAGE = 'index.html';

/* ============ Session ============ */

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) { goToLogin(); return null; }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') goToLogin();
  });
  return session;
}

export async function redirectIfLoggedIn() {
  if (await getSession()) window.location.replace(HOME_PAGE);
}

function goToLogin() {
  (window.top || window).location.replace(LOGIN_PAGE);
}

/* ============ Sign up ============ */

export async function signUp({ name, email, password, keyword, roll, branch, year, semester }) {
  if (!keyword || keyword.trim().length < 6) {
    throw new Error('The security keyword must contain at least 6 characters.');
  }

  const cleanEmail = email.trim().toLowerCase();

  // 1. E2EE Keys generate karo
  const identity = await createIdentity(keyword);

  // 2. Supabase mein user profile, roll number aur keys save karo
  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      emailRedirectTo: PRODUCTION_LOGIN_URL,
      data: {
        full_name: name.trim(),
        roll_no: roll.trim(),
        branch, year, semester,
        public_key: identity.publicJwk,
        key_backup: identity.backup
      }
    }
  });
  if (error) throw error;

  if (data.user && data.user.identities?.length === 0) {
    throw new Error('This email address is already registered.');
  }

  if (data.user) await saveLocalPrivateKey(data.user.id, identity.privateKey);

  // 3. Firebase ke through user ke Inbox mein 100% verified mail bhejo
  try {
    const firebase = await getFirebaseAuth();
    const fbCred = await firebase.createUserWithEmailAndPassword(firebase.auth, cleanEmail, password);
    await firebase.sendEmailVerification(fbCred.user, {
      url: PRODUCTION_LOGIN_URL,
      handleCodeInApp: false
    });
    await firebase.signOut(firebase.auth);
  } catch (fbErr) {
    console.warn('Firebase mail warning:', fbErr.message);
  }

  await supabase.auth.signOut();
  return { needsEmailConfirm: true };
}

/* ============ Sign in ============ */

async function resolveEmail(idOrEmail) {
  const v = idOrEmail.trim();
  if (v.includes('@')) return v.toLowerCase();
  const { data, error } = await supabase.rpc('email_for_roll', { p_roll: v });
  if (error || !data) throw new Error('Invalid roll number/email or password.');
  return data;
}

export async function signIn({ id, password }) {
  const email = await resolveEmail(id);

  // 1. Firebase se check karo ki user ne email verify kiya hai ya nahi
  try {
    const firebase = await getFirebaseAuth();
    const fbCred = await firebase.signInWithEmailAndPassword(firebase.auth, email, password);
    if (!fbCred.user.emailVerified) {
      await firebase.signOut(firebase.auth);
      throw new Error('EMAIL_NOT_VERIFIED');
    }
    await firebase.signOut(firebase.auth);
  } catch (fbErr) {
    if (fbErr.message === 'EMAIL_NOT_VERIFIED') {
      throw new Error('Please verify your email address first! Check your inbox for the verification link.');
    }
  }

  // 2. Supabase regular sign in
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid roll number/email or password.');

  const e2eeReady = await hasLocalKey(data.user.id);
  if (e2eeReady) await cleanupSignupMetadata(data.user);
  return { user: data.user, e2eeReady };
}

/* ============ E2EE unlock ============ */

export async function hasLocalKey(userId) {
  try { return !!(await getLocalPrivateKey(userId)); } catch { return false; }
}

export async function unlockWithKeyword(keyword) {
  const session = await getSession();
  if (!session) throw new Error('NOT_LOGGED_IN');
  const user = session.user;

  const { data: backup, error } = await supabase
    .from('key_backups').select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  if (!backup) throw new Error('NO_BACKUP');

  const key = await restoreIdentity(backup, keyword);
  if (isLocalKeyRemembered(user.id)) await saveLocalPrivateKey(user.id, key);
  else await wipeLocalKeys(user.id);
  try { await cleanupSignupMetadata(user); } catch { /* ignore */ }
  return key;
}

export async function changeSecurityKeyword({ currentPassword, currentKeyword, newKeyword }) {
  if (!currentPassword || !currentKeyword?.trim() || !newKeyword?.trim()) {
    throw new Error('MISSING_KEYWORD_FIELDS');
  }
  if (newKeyword.trim().length < 6) throw new Error('KEYWORD_TOO_SHORT');
  if (currentKeyword.trim().toLowerCase().normalize('NFKC') === newKeyword.trim().toLowerCase().normalize('NFKC')) {
    throw new Error('KEYWORD_UNCHANGED');
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const session = sessionData?.session;
  if (sessionError || !session?.user?.email) throw new Error('NOT_LOGGED_IN');

  const { error: passwordError } = await supabase.auth.signInWithPassword({
    email: session.user.email,
    password: currentPassword
  });
  if (passwordError) throw new Error('WRONG_ACCOUNT_PASSWORD');

  const { data: backup, error: backupError } = await supabase
    .from('key_backups').select('wrapped_key,salt,iv,iterations')
    .eq('user_id', session.user.id).maybeSingle();
  if (backupError) throw backupError;
  if (!backup) throw new Error('NO_BACKUP');

  const nextBackup = await rewrapIdentityBackup(backup, currentKeyword, newKeyword);
  const { error: updateError } = await supabase.rpc('rotate_my_key_backup', {
    p_expected_salt: backup.salt,
    p_wrapped_key: nextBackup.wrapped_key,
    p_salt: nextBackup.salt,
    p_iv: nextBackup.iv,
    p_iterations: nextBackup.iterations
  });
  if (updateError) throw updateError;
}

export async function setChatKeyRemembered(userId, remember) {
  await setLocalKeyRemembered(userId, remember);
}

async function cleanupSignupMetadata(user) {
  if (user.user_metadata?.key_backup) {
    await supabase.auth.updateUser({ data: { key_backup: null, public_key: null } });
  }
}

/* ============ Sign out ============ */

export async function signOut({ wipeKeys = false } = {}) {
  const session = await getSession();
  if (wipeKeys && session) await wipeLocalKeys(session.user.id);
  await supabase.auth.signOut();
  goToLogin();
}

export async function signOutEverywhere() {
  await supabase.auth.signOut({ scope: 'global' });
  goToLogin();
}

/* ============ Profile ============ */

export async function loadProfile() {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', session.user.id).single();
  if (error) throw error;
  return data;
}

export async function saveProfile({ full_name, bio, personal_email, roll_no, year, semester }) {
  const session = await getSession();
  if (!session) throw new Error('Please sign in again to update your profile.');

  const cleanRoll = String(roll_no || '').trim();
  const cleanYear = String(year || '').trim();
  const cleanSemester = String(semester || '').trim();
  if (!cleanRoll || cleanRoll.length > 32) throw new Error('Enter a valid roll number (up to 32 characters).');
  if (!['1st Year', '2nd Year', '3rd Year', '4th Year'].includes(cleanYear)) {
    throw new Error('Select a valid year.');
  }
  if (!/^[1-8]$/.test(cleanSemester)) throw new Error('Select a valid semester.');

  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: String(full_name || '').trim(),
      bio: String(bio || '').trim(),
      personal_email: String(personal_email || '').trim(),
      roll_no: cleanRoll,
      year: cleanYear,
      semester: cleanSemester
    })
    .eq('id', session.user.id);
  if (error) {
    if (error.code === '23505') throw new Error('This roll number is already assigned to another account.');
    throw error;
  }

  // Keep legacy pages (such as attendance) that still read student details
  // from auth metadata in sync with the authoritative profiles row.
  const { error: metadataError } = await supabase.auth.updateUser({
    data: {
      full_name: String(full_name || '').trim(),
      roll_no: cleanRoll,
      year: cleanYear,
      semester: cleanSemester
    }
  });
  if (metadataError) {
    console.warn('Student profile saved, but auth metadata could not be synced:', metadataError.message);
  }
}

export async function saveAvatarUrl(avatarUrl) {
  const { error } = await supabase.auth.updateUser({
    data: { avatar_url: avatarUrl || null }
  });
  if (error) throw error;
}

/* ============ Password ============ */

export async function changePassword(currentPassword, newPassword) {
  if (newPassword.length < 6) throw new Error('The new password must contain at least 6 characters.');
  const session = await getSession();
  const email = session.user.email;

  const { error: reauthErr } = await supabase.auth.signInWithPassword({
    email, password: currentPassword
  });
  if (reauthErr) throw new Error('The current password is incorrect.');

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;

  // Firebase me sync karo agar exist karta hai
  try {
    const firebase = await getFirebaseAuth();
    const fbCred = await firebase.signInWithEmailAndPassword(firebase.auth, email, currentPassword);
    await firebase.updatePassword(fbCred.user, newPassword);
    await firebase.signOut(firebase.auth);
  } catch (e) { /* ignore */ }
}

/* ============ Forgot Password ============ */

export async function resetPasswordRequest(idOrEmail) {
  const email = await resolveEmail(idOrEmail);
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${APP_URL}/reset_password.html`,
  });
  if (error) throw new Error('Unable to send reset link. Try again.');
}
