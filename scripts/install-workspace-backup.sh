#!/bin/bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $EUID -ne 0 ]]; then echo 'Запустите установку резервирования от root' >&2; exit 1; fi
install -d -m 700 /var/backups/kv9ru-workspace
install -d -m 755 /var/lib/kv9ru
if [[ ! -f /var/lib/kv9ru/backup-status.json ]]; then
    printf '%s\n' '{"ok":false,"verified":false,"external":false}' > /var/lib/kv9ru/backup-status.json
    chmod 644 /var/lib/kv9ru/backup-status.json
fi
cat > /etc/systemd/system/kv9ru-workspace-backup.service <<UNIT
[Unit]
Description=Verified snapshots of all KV9RU Workspace modules
After=docker.service
StartLimitIntervalSec=1h
StartLimitBurst=3
[Service]
Type=oneshot
Restart=on-failure
RestartSec=15min
ExecStart=/usr/bin/python3 ${repo_root}/scripts/workspace-backup.py snapshot
UMask=0077
Nice=10
CPUQuota=50%
IOSchedulingClass=idle
ProtectSystem=strict
ReadWritePaths=/var/backups/kv9ru-workspace /var/lib/kv9ru
PrivateTmp=yes
UNIT
cat > /etc/systemd/system/kv9ru-workspace-backup.timer <<'UNIT'
[Unit]
Description=Daily KV9RU Workspace backup
[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now kv9ru-workspace-backup.timer
