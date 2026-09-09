"""Offline package installation and squashfs repack inside the dedicated container."""
import hashlib,json,os,re,shlex,shutil,subprocess,tempfile,urllib.request
from pathlib import Path
from image import inspect_image,pack_image,PREFIX
from presets import validate,config_script

def run(args,timeout=240):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout,env={**os.environ,'LC_ALL':'C'})
    if result.returncode:raise ValueError('Ошибка '+Path(args[0]).name+': '+result.stdout.decode(errors='replace')[-1800:])
    return result.stdout

def safe(root,name):
    path=root/name
    if not path.resolve().is_relative_to(root.resolve()):raise ValueError('Недопустимая ссылка в образе: '+name)
    return path

def write(root,name,data,mode=0o600):
    p=safe(root,name);p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(data,encoding='utf-8');p.chmod(mode)

def packages(root):
    result={}
    for record in safe(root,'lib/apk/db/installed').read_text().split('\n\n'):
        fields=dict(line.split(':',1) for line in record.splitlines() if ':' in line)
        if 'P' in fields:result[fields['P']]=fields.get('V','')
    return result

def download(url,path,limit=8*1024*1024):
    request=urllib.request.Request(url,headers={'User-Agent':'KV9RU-Firmware/1.0'})
    with urllib.request.urlopen(request,timeout=60) as response,open(path,'wb') as f:
        total=0
        while chunk:=response.read(65536):
            total+=len(chunk)
            if total>limit:raise ValueError('Слишком большой пакет Podkop')
            f.write(chunk)

def build(image_path,body,output,progress=lambda message:None):
    config=validate(body);info,members=inspect_image(image_path.read_bytes())
    enrollment=body.get('enrollment')
    if config['frpc'] and (not isinstance(enrollment,dict) or not re.fullmatch('[a-f0-9]{64}',enrollment.get('token','')) or not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::\d+)?/api/frp/enroll',enrollment.get('endpoint',''))):raise ValueError('Не получены параметры регистрации FRPC')
    if shutil.disk_usage(output.parent).free<650*1024*1024:raise ValueError('Для сборки нужно не менее 650 МиБ свободного места')
    with tempfile.TemporaryDirectory(prefix='build-',dir=output.parent) as folder:
        work=Path(folder);root=work/'root';sq=work/'root.squashfs';sq.write_bytes(members[PREFIX+'/root'])
        progress('Распаковка rootfs')
        listing=run(['unsquashfs','-ll',str(sq)]).decode(errors='replace').splitlines()
        rows=[line.split(None,5) for line in listing if line.startswith(('-', 'd', 'l'))]
        if len(rows)>20000 or sum(int(row[2]) for row in rows if len(row)>5 and row[2].isdigit())>384*1024*1024:raise ValueError('Распакованная файловая система слишком велика')
        run(['unsquashfs','-processors','1','-d',str(root),str(sq)])
        for directory in ['etc','etc/apk','lib/apk','usr','bin','sbin','lib','etc/uci-defaults','etc/init.d','etc/rc.d','usr/libexec']:
            safe(root,directory)
        before=packages(root)
        if config['podkop'] and any(p in before for p in ['https-dns-proxy','nextdns','luci-app-passwall','luci-app-passwall2']):raise ValueError('В образе есть конфликтующий с Podkop DNS/VPN-пакет. Удалите конфликт в исходной сборке')
        version=info['version'];feeds=safe(root,'etc/apk/repositories.d');saved=work/'feeds';shutil.copytree(feeds,saved)
        for p in feeds.iterdir():
            if p.is_file() or p.is_symlink():p.unlink()
            else:raise ValueError('Неожиданный каталог репозиториев')
        original=(saved/'distfeeds.list').read_text()
        kernel=re.search(r'/kmods/(6\.12\.\d+-\d+-[a-f0-9]{32})/packages\.adb',original)
        if not kernel:raise ValueError('Не найден совместимый официальный репозиторий модулей ядра')
        base='https://downloads.openwrt.org/releases/'+version
        urls=[base+'/targets/mediatek/filogic/packages/packages.adb',base+'/targets/mediatek/filogic/kmods/'+kernel[1]+'/packages.adb']+[base+'/packages/aarch64_cortex-a53/'+f+'/packages.adb' for f in ['base','luci','packages','routing','telephony','video']]
        (feeds/'distfeeds.list').write_text('\n'.join(urls)+'\n')
        command=['apk','--root',str(root),'--arch','aarch64_cortex-a53']
        wanted=[]
        if config['frpc']:wanted+=['frpc','luci-app-frpc','curl','jq','ca-bundle']
        if config['podkop']:wanted+=['sing-box','curl','jq','kmod-nft-tproxy','coreutils-base64','bind-dig']
        if wanted:
            progress('Установка пакетов OpenWrt и зависимостей')
            run(command+['update'])
            run(command+['add','--no-scripts']+sorted(set(wanted)),timeout=600)
        podkop_version=None
        if config['podkop']:
            progress('Установка Podkop из официального выпуска')
            release_file=work/'release.json';download('https://api.github.com/repos/itdoginfo/podkop/releases/latest',release_file)
            release=json.loads(release_file.read_text());podkop_version=release['tag_name'];assets=[]
            for prefix in ['podkop-','luci-app-podkop-','luci-i18n-podkop-ru-']:
                found=[a for a in release.get('assets',[]) if a['name'].startswith(prefix) and a['name'].endswith('.apk')]
                if len(found)!=1:raise ValueError('В выпуске Podkop не найден однозначный APK: '+prefix)
                asset=found[0];url=asset['browser_download_url']
                if not url.startswith('https://github.com/itdoginfo/podkop/releases/download/'):raise ValueError('Неизвестный источник пакета Podkop')
                path=work/(prefix+'package.apk');download(url,path)
                digest=asset.get('digest')
                if digest and digest!='sha256:'+hashlib.sha256(path.read_bytes()).hexdigest():raise ValueError('Контрольная сумма пакета Podkop не совпала')
                assets.append(str(path))
            run(command+['--no-network','add','--no-scripts','--allow-untrusted']+assets)
        after=packages(root)
        changed=[name for name,version in before.items() if after.get(name)!=version]
        if changed:raise ValueError('Добавление пакетов изменяет исходные версии: '+', '.join(changed[:12])+'. Нужна совместимая исходная сборка')
        for p in feeds.iterdir():p.unlink()
        for p in saved.iterdir():shutil.copy2(p,feeds/p.name)
        progress('Добавление преднастройки WAN, LAN и Wi-Fi')
        write(root,'etc/uci-defaults/zzzz-kv9-preset',config_script(config),0o700)
        if config['frpc']:
            source=Path(__file__).parent
            write(root,'usr/libexec/kv9-frpc-enroll',(source/'enroll.sh').read_text(encoding='utf-8-sig'),0o700)
            write(root,'etc/init.d/kv9-frpc-enroll',(source/'enroll.init').read_text(encoding='utf-8-sig'),0o755)
            write(root,'etc/kv9-frpc-enrollment','token='+shlex.quote(enrollment['token'])+'\nendpoint='+shlex.quote(enrollment['endpoint'])+'\n')
        if config['podkop']:
            for p in safe(root,'etc/rc.d').glob('*'):
                if p.name.endswith(('podkop','sing-box')):p.unlink()
        # No package maintainer scripts run on the build host. UCI defaults run on the router.
        progress('Сборка squashfs и проверка sysupgrade')
        packed=work/'packed.squashfs'
        run(['mksquashfs',str(root),str(packed),'-noappend','-comp','xz','-b',str(info['block']),'-processors','1','-mem','128M','-no-progress'],timeout=600)
        members[PREFIX+'/root']=packed.read_bytes()
        result=pack_image(members,info['metadata']);outinfo,_=inspect_image(result)
        if outinfo['kernelSha256']!=info['kernelSha256']:raise ValueError('Ядро изменилось при сборке')
        verify=run(['unsquashfs','-cat',str(packed),'etc/uci-defaults/zzzz-kv9-preset']).decode()
        if verify!=config_script(config):raise ValueError('Преднастройка не прошла проверку')
        output.write_bytes(result);output.chmod(0o600)
        return {**outinfo,'packagesAdded':sorted(set(after)-set(before)),'podkopVersion':podkop_version,'enrollmentExpires':enrollment.get('expiresAt') if enrollment else None,'filename':'kv9ru-ax3000t-'+info['version']+'-sysupgrade.bin'}
