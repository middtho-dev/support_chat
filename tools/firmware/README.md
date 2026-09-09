# OpenWrt firmware preparation

Workspace → FRP → Прошивка supports **Xiaomi Mi Router AX3000T**, official-layout
`mediatek/filogic` OpenWrt 25.12.x squashfs/XZ sysupgrade archives. Other boards,
factory images and signed trailer variants are rejected. This is an offline
repack of the uploaded rootfs, not a replacement with a stock image.

Kernel bytes, CONTROL and supported-device metadata are preserved. Firmware CRC,
board, tar member allowlist, squashfs compression, output CRC and kernel SHA256
are validated. Original package versions must remain unchanged. No uploaded binary
or package maintainer script runs on the host. OpenWrt packages are installed by
host apk 3 with `--root --arch ... add --no-scripts`; firmware/custom feeds are
restored afterwards. Dependencies come only from matching official release feeds.
Podkop APKs come from https://github.com/itdoginfo/podkop/releases/latest,
with release SHA256 digests verified when present. Its installer is not executed
on the server. Podkop and sing-box stay disabled until manually configured.

Network configuration runs once through `etc/uci-defaults/zzzz-kv9-preset` after
board defaults. Keep old configuration **off** when flashing this prepared image.
Saved overlay settings can override the image. WAN device/VLAN and all unspecified
settings remain from the source. Selected Wi-Fi bands get one LAN AP; old SSIDs
are disabled, including old station/guest interfaces in that band. DHCP and static
WAN/LAN overlap validation prevent common lockout mistakes. The root password is
unchanged from the source firmware.

FRPC/LuCI are preinstalled. A boot service retries registration over HTTPS once
WAN and clock are available. The same FRP allocator used by the Windows installer
checks live, historical and reserved ports at first claim. One image capability
binds to one router MAC fingerprint, expires after 30 days and allocates no port
at build time. The resulting FRPC configuration remains editable in LuCI.
The capability is removed from the writable overlay after success; the firmware
itself still contains secrets. Treat the binary as confidential.

## Deployment

Copy `.env.example` to `.env`, generate a 32+ character random service token and
set the same `FIRMWARE_SERVICE_TOKEN` plus
`FIRMWARE_SERVICE_URL=http://127.0.0.1:7700` in the support service environment.
Run `docker compose up -d --build` in this directory, rebuild support-chat and FRP.
The worker is independently bounded to 1 CPU, 1 GiB RAM and one build at a time.
It has no Docker socket and exposes only loopback port 7700. Two source files and
two results are allowed, max 64 MiB each; expiration is 24 hours. Requires at least
650 MiB free for a build. Temporary rootfs is removed after success/failure.
Admin/Mini App manager authentication is enforced before streaming uploads or
issuing enrollment credentials. Operator and anonymous access are denied.

A built image still needs the router's normal LuCI/sysupgrade compatibility check.
Never bypass a mismatch with force. Tests cannot replace a real hardware boot test;
this workflow does not flash routers automatically.

Validation: `python3 -m unittest discover -s tools/firmware -p 'test_*.py'`, root
`npm run check && npm test`, and `node --test tools/frp/test`.
