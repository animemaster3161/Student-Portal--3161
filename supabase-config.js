// supabase-config.js
// Supabase dashboard -> Project Settings -> API se dono values copy karo.
// anon key public hoti hai (frontend me rakhna safe hai) -- security RLS se aati hai, key chhupane se nahi.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const SUPABASE_URL = 'https://ixaxvcinbbbqriylqcvi.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4YXh2Y2luYmJicXJpeWxxY3ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4MTI1OTgsImV4cCI6MjEwNzM4ODU5OH0._u3etS_EvChQfFYF3YIeXriB2AM1h7sxCw28FDjZTas';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,        // refresh token browser localStorage me store hota hai
    autoRefreshToken: true,      // access token expire hone se pehle khud renew
    detectSessionInUrl: true,    // email-confirm / reset links ke liye
    storageKey: 'mgm-portal-auth'
  }
});

// Staff console keeps its browser session separate from the student portal.
export function createStaffClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'mgm-academic-staff-auth'
    }
  });
}
