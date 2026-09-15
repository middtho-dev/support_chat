"""Keep the vendor sysupgrade bytes intact; provision using sysupgrade -f."""
import gzip,hashlib,io,shlex,tarfile,zipfile
from pathlib import Path
from presets import config_script

FORMAT='original-sysupgrade-bundle-v2'

def sha(data):return hashlib.sha256(data).hexdigest()

def create_bundle(image,info,config,enrollment,packages,output):
    source=Path(__file__).parent
    entries={'etc/uci-defaults/zzzz-kv9-preset':(config_script(config).encode(),0o700)}
    links={}
    if config['frpc']:
        entries['etc/kv9-frpc-enrollment']=(('token='+shlex.quote(enrollment['token'])+'\nendpoint='+shlex.quote(enrollment['endpoint'])+'\n').encode(),0o600)
        entries['usr/libexec/kv9-frpc-enroll']=((source/'enroll.sh').read_bytes().replace(b'\r\n',b'\n'),0o700)
        entries['usr/libexec/kv9-frpc-provision']=((source/'provision.sh').read_bytes().replace(b'\r\n',b'\n'),0o700)
        init=(source/'enroll.init').read_bytes().replace(b'\r\n',b'\n').replace(b'/usr/libexec/kv9-frpc-enroll',b'/usr/libexec/kv9-frpc-provision')
        entries['etc/init.d/kv9-frpc-enroll']=(init,0o755)
        links['etc/rc.d/S99kv9-frpc-enroll']='../init.d/kv9-frpc-enroll'
        checks=[]
        for name,data in packages.items():
            entries['etc/kv9-firmware/'+name]=(data,0o600);checks.append(sha(data)+'  '+name)
        if checks:entries['etc/kv9-firmware/SHA256SUMS']=(('\n'.join(checks)+'\n').encode(),0o600)
    tar=io.BytesIO()
    with tarfile.open(fileobj=tar,mode='w',format=tarfile.USTAR_FORMAT) as archive:
        for name,(data,mode) in entries.items():
            item=tarfile.TarInfo(name);item.mode=mode;item.size=len(data);archive.addfile(item,io.BytesIO(data))
        for name,target in links.items():
            item=tarfile.TarInfo(name);item.type=tarfile.SYMTYPE;item.linkname=target;item.mode=0o777;archive.addfile(item)
    settings=gzip.compress(tar.getvalue(),mtime=0)
    check='''#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || exit 1
[ "$(cat /tmp/sysinfo/board_name)" = 'xiaomi,mi-router-ax3000t' ] || { echo 'Wrong router/bootloader layout'; exit 1; }
command -v sysupgrade >/dev/null
sha256sum -c SHA256SUMS
sysupgrade -T -f settings.tar.gz firmware.bin
'''.encode()
    readme='''KV9RU — комплект обновления OpenWrt AX3000T

firmware.bin — исходный файл, побайтно неизменный.
settings.tar.gz — выбранные WAN/LAN/Wi-Fi и установка FRPC при первом запуске.
Podkop и его зависимости не добавляются. Пакеты FRPC проверяются по подписанным индексам OpenWrt и устанавливаются самим роутером без скачивания.

Windows: распакуйте ZIP целиком, подключитесь кабелем к роутеру и запустите install.cmd.
Нужен OpenSSH Client. Укажите текущий IP роутера и пароль root в запросах SSH.
Установщик проверит контрольные суммы, модель и sysupgrade -T, сохранит старую конфигурацию на ПК.
Прошивка начинается только после ввода UPDATE. Не отключайте питание; обеспечьте возможность восстановления на месте.
Не используйте -F/--force. Разрыв SSH при обновлении не подтверждает успешную загрузку.

Linux/macOS: загрузите firmware.bin, settings.tar.gz, SHA256SUMS и check.sh в один каталог /tmp на роутере.
Сначала выполните sh check.sh. Сохраните sysupgrade -b /tmp/before-upgrade.tar.gz и скачайте резервную копию на ПК.
Только после успешной проверки: sysupgrade -f settings.tar.gz firmware.bin
При -f восстанавливается именно приложенный архив; текущие настройки роутера не сохраняются в новую систему.
Если прошить только firmware.bin через LuCI, наши настройки и FRPC не применятся.

После загрузки: LAN — {lan}. FRPC получит порт при доступности Интернета и FRP сервера.
Диагностика FRPC: logread -e kv9; /tmp/kv9-frpc-enroll.log. Старые сетевые настройки не подменяют выбранные.
Архив содержит пароли и ключ регистрации FRPC: храните его как конфиденциальный файл.
Работа на реальном роутере не подтверждена серверными проверками. Отказ предыдущего образа не диагностирован без журнала загрузки.
'''.format(lan=config['lan']['ip'] if config['lan']['configure'] else 'из исходной прошивки').encode('utf-8')
    payload={'firmware.bin':image,'settings.tar.gz':settings,'check.sh':check}
    payload['SHA256SUMS']=(''.join(sha(data)+'  '+name+'\n' for name,data in payload.items())).encode()
    payload['README.txt']=readme
    payload['install.ps1']=(source/'install.ps1').read_bytes()
    payload['install.cmd']=b'@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"\r\n'
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_STORED) as archive:
        for name,data in payload.items():archive.writestr(name,data)
    output.chmod(0o600)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() or archive.read('firmware.bin')!=image:raise ValueError('Исходная прошивка изменилась или ZIP повреждён')
    return {'format':FORMAT,'sourceSha256':info['sha256'],'sha256':sha(output.read_bytes()),'size':output.stat().st_size,'filename':'kv9ru-ax3000t-'+info['version']+'-original-and-settings.zip','kernelSha256':info['kernelSha256'],'enrollmentExpires':enrollment.get('expiresAt') if enrollment else None}
