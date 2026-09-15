# Original OpenWrt image + provisioning bundle

FRP → Прошивка accepts Xiaomi AX3000T mediatek/filogic OpenWrt 25.12.x
squashfs sysupgrade images. It returns a ZIP, not a modified firmware image.
firmware.bin in that ZIP is byte-for-byte identical to the uploaded file.
The rootfs, kernel, metadata, permissions, compression and installed packages
in that file are never rewritten. Model/CRC/structure validation is not a
hardware boot guarantee.

settings.tar.gz uses the supported sysupgrade -f configuration restore
mechanism. A UCI defaults script applies selected WAN, LAN and Wi-Fi settings
on first boot. Unselected settings and the root password come from the source
image, not the router's old overlay. Old configuration is backed up to the PC
before the installer requests the explicit UPDATE confirmation.

FRPC, LuCI and missing dependencies are resolved against a disposable copy of
the source package database with every original package version pinned. Only
new official OpenWrt APKs and their signed repository indexes are included. The
router's own APK installs them offline in an asynchronous boot service, with
native package scripts and signature checks enabled. FRPC then registers over
HTTPS and obtains a free port from the existing allocator. Internet is needed
for registration, but not package installation. Podkop installation is removed;
API requests asking for it are rejected. Existing packages in an uploaded image
are never removed.

Windows: extract the ZIP, run install.cmd, enter the router IP/root password.
Requires Windows OpenSSH Client. It checks hashes, exact board ID and
sysupgrade -T -f, downloads a configuration backup, then asks for UPDATE.
It never uses --force. SSH disconnect is explicitly not reported as boot
success. Use a wired connection, stable power and access to recovery on site.
For macOS/Linux, commands are included in the ZIP's README. Flashing only the
unchanged BIN in LuCI does not apply the supplied configuration or FRPC.

The bundle contains credentials. Downloads require manager authorization;
files expire after 24 hours. The worker exposes loopback 7700, has no Docker
socket, limits CPU/RAM and runs one preparation at a time. Configure matching
FIRMWARE_SERVICE_TOKEN in its .env and the support service environment,
then docker compose -f tools/firmware/compose.yml up -d --build and rebuild
support-chat. Old repacked results cannot be downloaded by this version.

Validation: python3 -m unittest discover -s tools/firmware -p 'test_*.py',
pwsh -File tools/firmware/test_install.ps1, npm run check, npm test.

## September 2026 incident

A user reported a remote router did not come back after an earlier repacked
image. The actual flashed file and boot log were unavailable (stored artifacts
had expired). Reproducing the old FRPC-only path preserved existing boot-file
contents and permissions; it did change squashfs packaging and APK metadata.
That does not establish the cause of the reported failure or prove Podkop was
responsible. The old repacking method was withdrawn. Version 2 removes it from
the production path rather than claiming a smaller repacked image is safe.
No physical router was flashed or recovered during these checks.

OpenWrt implementation of -f and -T:
https://github.com/openwrt/openwrt/blob/v25.12.5/package/base-files/files/sbin/sysupgrade
