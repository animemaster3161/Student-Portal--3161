(() => {
  const style = document.createElement('style');
  style.textContent = `
    .portal-toast-stack{position:fixed;right:20px;top:20px;z-index:100000;display:grid;gap:10px;pointer-events:none}
    .portal-toast{max-width:min(380px,calc(100vw - 32px));padding:12px 16px;border-radius:12px;background:#14213d;color:#fff;box-shadow:0 12px 34px #08152c33;font:500 14px/1.5 Inter,system-ui,sans-serif;animation:portal-toast-in .18s ease-out}
    .portal-toast.error{background:#8f2832}.portal-dialog-backdrop{position:fixed;inset:0;z-index:100001;background:#09132699;display:grid;place-items:center;padding:20px}
    .portal-dialog{width:min(420px,100%);padding:22px;border-radius:18px;background:#fff;color:#17233b;box-shadow:0 24px 70px #07122c55;font:14px/1.55 Inter,system-ui,sans-serif}
    .portal-dialog h2{margin:0 0 8px;font-size:18px}.portal-dialog p{margin:0 0 20px;color:#59667d;white-space:pre-line}
    .portal-dialog-actions{display:flex;justify-content:flex-end;gap:10px}.portal-dialog button{border:0;border-radius:10px;padding:10px 15px;font:600 14px/1.2 Inter,system-ui,sans-serif;cursor:pointer}
    .portal-dialog-cancel{background:#eef1f6;color:#25324a}.portal-dialog-ok{background:#315de8;color:#fff}.portal-dialog-ok.danger{background:#c33b47}
    @keyframes portal-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
    @media(max-width:600px){.portal-toast-stack{top:auto;right:12px;bottom:16px;left:12px}.portal-toast{max-width:none}}
  `;
  document.head.append(style);
  const stack = document.createElement('div');
  stack.className = 'portal-toast-stack'; stack.setAttribute('aria-live', 'polite'); document.body.append(stack);

  window.portalToast = (message, type = 'success') => {
    const item = document.createElement('div'); item.className = `portal-toast${type === 'error' ? ' error' : ''}`;
    item.textContent = String(message); stack.append(item); setTimeout(() => item.remove(), 4200);
  };

  window.portalConfirm = (message, options = {}) => new Promise(resolve => {
    const backdrop = document.createElement('div'); backdrop.className = 'portal-dialog-backdrop';
    const dialog = document.createElement('section'); dialog.className = 'portal-dialog'; dialog.role = 'dialog'; dialog.ariaModal = 'true';
    const title = document.createElement('h2'); title.textContent = options.title || 'Please confirm';
    const text = document.createElement('p'); text.textContent = message;
    const actions = document.createElement('div'); actions.className = 'portal-dialog-actions';
    const cancel = document.createElement('button'); cancel.className = 'portal-dialog-cancel'; cancel.textContent = options.cancelText || 'Cancel';
    const accept = document.createElement('button'); accept.className = `portal-dialog-ok${options.danger ? ' danger' : ''}`; accept.textContent = options.confirmText || 'Continue';
    actions.append(cancel, accept); dialog.append(title, text, actions); backdrop.append(dialog); document.body.append(backdrop);
    const finish = value => { backdrop.remove(); resolve(value); };
    cancel.addEventListener('click', () => finish(false)); accept.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(false); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') finish(false); });
    accept.focus();
  });
})();
