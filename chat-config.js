// chat-config.js

// Cloudinary: Settings -> Upload -> Upload presets -> Add preset
//   Signing mode: UNSIGNED  |  (Folder: chat-attachments)  -> preset ka naam yahan daalo
// Cloud name dashboard ke top par milta hai.
// (Purane archives bhi isi Cloudinary account me hain; URLs Supabase 'chat_archives' table se aate hain.)
export const CLOUDINARY_CLOUD = 'jgkwrktm';
export const CLOUDINARY_PRESET = 'mgm_chat';

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
export const PAGE_SIZE = 40;                 // ek baar me kitne msgs load hon
export const CHAT_ARCHIVE_BATCH_SIZE = 10;
export const CHAT_ARCHIVE_KEEP_RECENT = 10;
export const CHAT_ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;
export const ENABLE_PRESENCE = true;              // Online/Offline dot (false karne par Realtime load kam hota hai)
