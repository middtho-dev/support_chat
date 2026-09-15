"""Resolve FRPC packages offline; never repack or modify the uploaded firmware."""
import os,re,shutil,subprocess,tempfile,urllib.request
from pathlib import Path
from image import inspect_image,PREFIX
from bundle import create_bundle
from presets import validate

def run(args,timeout=240):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout,env={**os.environ,'LC_ALL':'C'})
    if result.returncode:raise ValueError('Ошибка '+Path(args[0]).name+': '+result.stdout.decode(errors='replace')[-1800:])
    return result.stdout

def safe(root,name):
    path=root/name
    if not path.resolve().is_relative_to(root.resolve()):raise ValueError('Недопустимая ссылка в образе: '+name)
    return path

def packages(root):
    result={}
    for record in safe(root,'lib/apk/db/installed').read_text().split('\n\n'):
        fields=dict(line.split(':',1) for line in record.splitlines() if ':' in line)
        if 'P' in fields:result[fields['P']]=fields.get('V','')
    return result

def build(image_path,body,output,progress=lambda message:None):
    config=validate(body);image=image_path.read_bytes();info,members=inspect_image(image)
    enrollment=body.get('enrollment')
    if config['frpc'] and (not isinstance(enrollment,dict) or not re.fullmatch('[a-f0-9]{64}',enrollment.get('token','')) or not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::\d+)?/api/frp/enroll',enrollment.get('endpoint',''))):raise ValueError('Не получены параметры регистрации FRPC')
    if shutil.disk_usage(output.parent).free<650*1024*1024:raise ValueError('Для подготовки нужно не менее 650 МиБ свободного места')
    package_files={};added=[]
    # This root is disposable dependency-resolution input. It NEVER becomes a firmware image.
    if config['frpc']:
        with tempfile.TemporaryDirectory(prefix='resolve-',dir=output.parent) as folder:
            work=Path(folder);root=work/'root';sq=work/'root.squashfs';sq.write_bytes(members[PREFIX+'/root'])
            progress('Проверка исходных пакетов FRPC')
            listing=run(['unsquashfs','-ll',str(sq)]).decode(errors='replace').splitlines()
            rows=[line.split(None,5) for line in listing if line.startswith(('-', 'd', 'l'))]
            if len(rows)>20000 or sum(int(row[2]) for row in rows if len(row)>5 and row[2].isdigit())>384*1024*1024:raise ValueError('Распакованная файловая система слишком велика')
            run(['unsquashfs','-processors','1','-d',str(root),str(sq)])
            for directory in ['etc','etc/apk','lib/apk','usr','bin','sbin','lib']:safe(root,directory)
            before=packages(root)
            feeds=safe(root,'etc/apk/repositories.d')
            for p in feeds.iterdir():
                if p.is_file() or p.is_symlink():p.unlink()
                else:raise ValueError('Неожиданный каталог репозиториев')
            base='https://downloads.openwrt.org/releases/'+info['version']
            urls=[base+'/targets/mediatek/filogic/packages/packages.adb']+[base+'/packages/aarch64_cortex-a53/'+f+'/packages.adb' for f in ['base','luci','packages','routing']]
            (feeds/'distfeeds.list').write_text('\n'.join(urls)+'\n')
            command=['apk','--root',str(root),'--arch','aarch64_cortex-a53']
            wanted=['frpc','luci-app-frpc','curl','jq','ca-bundle']
            progress('Подготовка подписанных пакетов OpenWrt')
            run(command+['update'])
            # Pin every installed package, so solving cannot upgrade or remove base-system packages.
            run(command+['add','--no-scripts']+wanted+[name+'='+version for name,version in before.items()],timeout=600)
            after=packages(root)
            changed=[name for name,version in before.items() if after.get(name)!=version]
            if changed:raise ValueError('FRPC требует изменения исходных пакетов: '+', '.join(changed[:12]))
            added=sorted(set(after)-set(before))
            if any(name in added for name in ['podkop','luci-app-podkop','sing-box']):raise ValueError('Недопустимые зависимости FRPC')
            payload=work/'packages';payload.mkdir()
            if added:run(command+['fetch','--output',str(payload)]+added,timeout=600)
            for p in payload.glob('*.apk'):
                if not re.fullmatch(r'[A-Za-z0-9_.+~-]+\.apk',p.name):raise ValueError('Некорректное имя пакета')
                package_files[p.name]=p.read_bytes()
            if set(package_files)!={name+'-'+after[name]+'.apk' for name in added}:raise ValueError('Версии скачанных пакетов изменились. Повторите подготовку')
            if len(package_files)!=len(added) or sum(map(len,package_files.values()))>24*1024*1024:raise ValueError('Неполный или слишком большой набор пакетов FRPC')
            # OpenWrt signs repository indexes, not each APK. Keep those signed indexes
            # beside the packages so native offline installation can verify trust.
            files={};used={}
            for name in added:
                url=run(command+['fetch','--url',name]).decode().strip()
                filename=name+'-'+after[name]+'.apk'
                matches=[i for i,feed in enumerate(urls) if url==feed.rsplit('/',1)[0]+'/'+filename]
                if len(matches)!=1:raise ValueError('Неизвестный источник пакета '+name)
                index=matches[0];used[index]=urls[index]
                files['repos/'+str(index)+'/'+filename]=package_files[filename]
            for index,url in used.items():
                with urllib.request.urlopen(url,timeout=60) as response:data=response.read(4*1024*1024+1)
                if len(data)>4*1024*1024:raise ValueError('Слишком большой индекс репозитория')
                files['repos/'+str(index)+'/packages.adb']=data
            if added:
                files['repositories']=(''.join('/etc/kv9-firmware/repos/'+str(index)+'/packages.adb\n' for index in used)).encode()
                files['constraints']=(''.join(name+'='+after[name]+'\n' for name in added)).encode()
            package_files=files
    progress('Комплект с неизменной прошивкой и преднастройкой')
    result=create_bundle(image,info,config,enrollment,package_files,output)
    return {**result,'packagesAdded':added,'version':info['version'],'board':info['board']}
