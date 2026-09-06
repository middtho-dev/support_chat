'use strict';
window.FRP_INTEGRATION = {
  state: S,
  toast,
  openLink: url => {
    if (TG?.openLink && /^https?:/.test(url)) TG.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
};
socket.on('admin_auth_ok', () => {
  document.querySelector('[data-view="frp"]').hidden = !S.permissions.canManageSettings;
  window.FrpPanel?.reset();
  if (S.permissions.canManageSettings && (S.view === 'frp' || new URLSearchParams(location.search).get('view') === 'frp')) setView('frp');
});
socket.on('disconnect', () => window.FrpPanel?.reset());
socket.on('admin_settings_forbidden', () => {
  document.querySelector('[data-view="frp"]').hidden = true;
  window.FrpPanel?.reset();
  if (S.view === 'frp') setView('chat');
});
