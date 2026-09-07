(function () {
 'use strict';
 if (window.workspaceBootstrap) return;
 window.workspaceBootstrap = true;
 var loading = false;
 function load() {
  if (window.workspaceDeviceControl) return;
  if (!window.Lampa || !Lampa.Storage || !Lampa.SettingsApi || loading) {
   setTimeout(load, 1000); return;
  }
  loading = true;
  var script = document.createElement('script');
  script.src = '/workspace-client.js?bootstrap=1';
  script.async = true;
  script.onload = script.onerror = function () {
   loading = false;
   script.remove();
   if (!window.workspaceDeviceControl) setTimeout(load, 5000);
  };
  document.head.appendChild(script);
 }
 load();
})();
