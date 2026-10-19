import { CLOUDINARY_CLOUD, CLOUDINARY_PRESET } from './chat-config.js';

export function makeRecoveryCodes(keywordBackup, recoveryBackup) {
  return {
    format: 'mgm-chat-recovery-v2',
    backup: recoveryBackup,
    keyword_backup: keywordBackup
  };
}

export function recoveryCodesBlob(recoveryCodes) {
  return new Blob([JSON.stringify(recoveryCodes, null, 2)], { type: 'application/json' });
}

export function downloadRecoveryCodes(recoveryCodes, filename = 'MGMCOET-Recovery-Codes.json') {
  const url = URL.createObjectURL(recoveryCodesBlob(recoveryCodes));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function uploadRecoveryCodes(fileOrPayload, filename = 'MGMCOET-Recovery-Codes.json') {
  if (!CLOUDINARY_CLOUD || CLOUDINARY_CLOUD.startsWith('YOUR') || !CLOUDINARY_PRESET) {
    throw new Error('CLOUDINARY_NOT_CONFIGURED');
  }
  const blob = fileOrPayload instanceof Blob ? fileOrPayload : recoveryCodesBlob(fileOrPayload);
  const body = new FormData();
  body.append('file', blob, filename);
  body.append('upload_preset', CLOUDINARY_PRESET);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD)}/raw/upload`, {
    method: 'POST', body
  });
  let result = {};
  try { result = await response.json(); } catch { /* report status below */ }
  if (!response.ok || !result.secure_url) {
    throw new Error(result.error?.message || `Cloudinary upload failed (${response.status}).`);
  }
  return result.secure_url;
}
