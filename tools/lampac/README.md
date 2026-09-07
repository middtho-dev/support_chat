# Lampac workspace module

Lampac stays an independent native systemd service. The workspace uses its existing
manager/Mini App authorization and talks to a token-protected loopback Python API.
The agent runs as `lampac`, not root. Its sudo allowlist controls only lampac.service.
No Docker socket, arbitrary shell commands, root password or Lampac password reach the browser.

Install agent.py, advanced.py, devices.py, client-profile.js device-client.js, bootstrap.js and activation.html in /usr/local/lib/lampac-workspace (root-owned), the supplied unit in
/etc/systemd/system and sudoers in /etc/sudoers.d/lampac-workspace (0440; validate with visudo).
Create /etc/lampac-workspace.env (root-owned, 0600) with LAMPAC_SERVICE_TOKEN (random 32+
characters), LAMPAC_DIR=/opt/lampac, LAMPAC_AGENT_PORT=7600 and LAMPAC_PUBLIC_URL=https://lc.kv9.ru.
Use the same service token in the main application's .env, along with
LAMPAC_SERVICE_URL=http://127.0.0.1:7600 and LAMPAC_PUBLIC_URL. Enable lampac-workspace.service.
Changing a public domain also requires updating DNS, Caddy and Lampac listen.host/scheme.

Caddy serves lc.kv9.ru with automatic HTTPS and reverse_proxy 127.0.0.1:9118.
Set listen.ip to 127.0.0.1, listen.scheme to https and listen.host to lc.kv9.ru in
Lampac init.conf. Keep all unrelated settings. Validate Caddy before reloading it.
Restrict the native TorrServer HTTP port (9085) to loopback using host firewall;
its peer ports are separate. Reserve 7600, 9085 and 9118 in FRP to avoid conflicts.

The panel patches a validated allowlist of JSON init.conf settings. Provider fields are
discovered from current.conf only when the installed provider exposes them. Passwords
and tokens are write-only; a blank input preserves the existing credential. JSON with comments
and init.yaml are intentionally not rewritten. Backups are under
/opt/lampac/database/backup/workspace. Save followed by restart applies module changes.
An existing SkipModules array is retained except for the four exposed module switches.
Custom LoadModules allowlists can still prevent a module from loading.

TorrServer settings are read and written through its authenticated local /settings API;
credentials come from data/ts/accs.db and are never returned. Unexposed fields are preserved,
and each write is followed by a readback check. Disk caching uses an existing configured
path, or data/ts/workspace-cache when no path is set. Cache size is per torrent, in MiB;
speed limits are KB/s, with zero meaning unlimited. Live changes may interrupt streams.
Keep /ts/settings readable: Lampa needs POST {"action":"get"} before playback.
Set TorrServer.rdb=true in init.conf to prevent external writes through Lampac while
allowing local agent writes. Caddy blocks only /ts/shutdown. The agent restarts the
exact Lampac-owned TorrServer executable with SIGTERM and verifies its replacement
PID and settings API; no whole-Lampac restart is required. Unchanged settings are
not written, avoiding unnecessary interruption of active streams.

## Expanded controls

The Torrents tab uses the installed MatriX.135 /torrents API (list, drop, rem). Drop
unloads a torrent but retains a saved database entry. Removal deletes it and its cache;
the UI asks for confirmation for each target. Polling never calls get: that operation
can wake a saved torrent. Peer counts describe the swarm, not viewers.

For connection observations and IP blocking, install caddy-workspace.conf as
/etc/systemd/system/caddy.service.d/workspace.conf. Run systemctl daemon-reload;
validate the supplied lampac.caddy with LAMPAC_SERVICE_TOKEN loaded from the private
environment file, then reload Caddy. The systemd EnvironmentFile is read by the reload
command too. Do not put a literal token in a public Caddyfile or repository.
The token-authenticated /access endpoint receives the socket IP from Caddy, not a
client-provided forwarding header. It gates every public Lampac request, including the
preferences plugin. Agent downtime therefore makes the public service unavailable;
keep lampac-workspace.service enabled with its restart policy. The support panel is
independent, so managers can still remove a block affecting their own public IP.

Observations and persistent block rules live in database/workspace/access.db. Only
IP, bounded User-Agent, timestamps, counts, route category and a torrent hash are
recorded; query strings and account tokens are discarded. Observations retain at most
2000 IP/browser combinations for seven days; the UI shows the newest 500. An IP/browser
combination is not an authenticated device identity. Behind NAT a block affects all
devices using that IP. It affects new requests; existing streams may need a targeted
torrent drop. Direct loopback/backend access is outside this gate. Keep 9118/9085 private.

The Lampa profile is stored as WorkspaceUI in init.conf and delivered as a public,
credential-free /workspace-client.js plugin. Saving a profile adds just this managed
entry to LampaWeb.customPlugins, preserving other plugins. LampaWeb auto-loads it;
external Lampa installations must install the plugin URL manually. Profiles can be
disabled, applied once per revision, or on every application launch. Only selected
keys are managed. Releasing keys restores previous values only if the device has not
changed them since. Some preferences require a subsequent Lampa reload because the
plugin runs after initial application setup. No automatic reload interrupts playback.
Disabling a profile keeps the plugin installed so devices can release managed keys.
Supported keys are verified against yumata/lampa app.min.js; provider and plugin fields
against lampac-nextgen/lampac Modules/LampaWeb and Shared provider configuration models.

## Device control

The profile includes internal_torrclient, the Android/Android TV built-in torrent
client switch. It cannot install a native engine on unsupported TV platforms.
The Workspace plugin automatically enrolls each new installation using a random,
device-scoped credential. No code or extra login is required. Managers alone can
configure, rename or disable enrolled devices; enrollment grants no panel access.
The existing manual code endpoints remain for old clients.

An installation's server ID and credential persist in Lampa storage. Names are
independent of IDs. Clearing app storage or using another browser creates a different
installation; these IDs are not hardware identifiers. Credentials are hashed in
 database/workspace/devices.db. Disabling access preserves the ID and settings, and
can be reversed. Deleting a record revokes its credential; the plugin does not silently
re-enroll a revoked session. A local polling pause preserves the credential and ID.

Per-device desired settings are persistent overrides. They merge cumulatively and
are reapplied over the global profile on launch and after polling. A field can return
to inheritance, removing only that override. Global profile changes cannot overwrite
remaining individual values. The plugin caches overrides for startup while offline.
Only the preference allowlist is reported; accounts, passwords and history are absent.
The panel displays actual reported values separately from desired overrides and
queued/applied revisions. Settings include parser, playback, subtitles, proxy,
interface sound, card appearance and menu visibility. Menu switches hide only known
menu entries, not backend APIs or permissions.

The disabled-device screen pauses HTML video and blocks interaction when the next
poll arrives (normally ten seconds). For same-origin Lampa, the plugin sets a secure
workspace_device cookie and Caddy's authenticated gate rejects new service requests
for disabled credentials. The control poll remains reachable so access can be restored.
External/native players may not carry this cookie; already-open streams may continue.
This controls known installations, not hostile users who erase storage or use another
client. Use the existing IP block for address-wide restrictions.

Caddy forwards /workspace-device/* to the agent with the trusted service token and
socket IP. Scoped tokens travel in POST bodies, not URLs. Public POST/OPTIONS supports
external Lampa origins; manager routes stay private. The access gate accepts retained
asset queries such as /access?v=1987573. Caddy normalizes duplicate leading slashes
before routing, preserving query strings and the shutdown guard.

## Managed device settings and activation

New registrations start with access disabled; existing rows keep their access.
The administrator enables access in Devices. The activation screen polls every
5 seconds after a blocked page reload; the running plugin polls every 10 seconds.
The screen uses WORKSPACE_SUPPORT_URL (default https://helpo.su) and
WORKSPACE_LOGO_URL (default the support URL plus /logo.png) from the agent environment.
Only informational status is exposed in the device's Workspace section. Old local
pause flags are cleared; revoked credentials remain revoked.

General preferences show basics, left-menu visibility and settings-section access.
Detailed overrides are grouped per device and override general preferences.
The management switch enables an override; turning it off restores inheritance.
Existing hidden general values are preserved on save for backward compatibility.
Settings restrictions hide native sections, remove remote-control focus targets
and reject direct settings navigation. “Other plugins” covers unknown sections.
These are client UI restrictions, not protection against modifying the client code.

## Automatic bootstrap for existing web clients

Caddy serves `/` and `/index.html` through the loopback agent, which reads the
current native Lampac page and inserts `/workspace-bootstrap.js`. It does not
modify Lampac files, plugin lists, localStorage, IndexedDB or cached media.
Only the HTML wrapper and bootstrap use no-store; application assets keep their
existing cache behavior. The loader waits for Lampa, retries transient script
failures and skips already running Workspace instances. Native customPlugins
remain a second path and the device plugin prevents duplicate registration.

Existing users receive the loader on the next network-backed page load. An
already open/offline cached page cannot be updated until it contacts the server.
Standalone Lampa applications using only video APIs do not load this HTML and
still need the Workspace plugin installed once. Newly discovered installations
follow the normal activation policy; existing Workspace IDs are preserved.

Deleting a device invalidates its cookie immediately. Unknown credentials are
rejected for content access but may enroll again. The plugin (or standalone
activation screen after reload) handles the explicit device_revoked response by
registering a fresh, disabled installation. It must be approved again. Temporary
network or IP-block errors do not trigger reenrollment. The UI reacts on the next
poll; already established media connections are not retroactively terminated.
