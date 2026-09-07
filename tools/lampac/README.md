# Lampac workspace module

Lampac stays an independent native systemd service. The workspace uses its existing
manager/Mini App authorization and talks to a token-protected loopback Python API.
The agent runs as `lampac`, not root. Its sudo allowlist controls only lampac.service.
No Docker socket, arbitrary shell commands, root password or Lampac password reach the browser.

Install agent.py in /usr/local/lib/lampac-workspace (root-owned), the supplied unit in
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

The panel patches only a small allowlist of JSON init.conf settings. JSON with comments
and init.yaml are intentionally not rewritten. Backups are under
/opt/lampac/database/backup/workspace. Save followed by restart applies module changes.
An existing SkipModules array is retained except for the four exposed module switches.
Custom LoadModules allowlists can still prevent a module from loading.

TorrServer settings are read and written through its authenticated local /settings API;
credentials come from data/ts/accs.db and are never returned. Unexposed fields are preserved,
and each write is followed by a readback check. Disk caching uses an existing configured
path, or data/ts/workspace-cache when no path is set. Cache size is per torrent, in MiB;
speed limits are KB/s, with zero meaning unlimited. Live changes may interrupt streams.
Do not expose TorrServer settings/shutdown through the public Caddy route; these are
managed by the authenticated workspace instead.

Validation: python3 -m unittest discover -s tools/lampac -p 'test_*.py', npm run check,
npm test. Source references: lampac-nextgen/lampac Modules/TorrServer and
YouROK/TorrServer server/web/api/settings.go and server/settings/btsets.go.
