#!/usr/bin/env python3
"""Private, deduplicated Workspace snapshots; restore only into an empty staging directory."""
import argparse,datetime,fcntl,hashlib,json,os,pathlib,re,shutil,sqlite3,subprocess,tempfile
DEFAULT_DEST='/var/backups/kv9ru-workspace'
STATUS='/var/lib/kv9ru/backup-status.json'
HEX=re.compile(r'^[a-f0-9]{64}$')
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def atomic_json(path,value,mode=0o600):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2));tmp.chmod(mode);os.replace(tmp,path)
def private_dir(path):path.mkdir(parents=True,exist_ok=True);path.chmod(0o700)
def discover(repository):
 containers=['support-chat','frp-frp-panel-1','voice-voice-1','video-video-1','firmware-firmware-1']
 data=json.loads(subprocess.check_output(['docker','inspect',*containers],text=True));sources={};images={}
 for item in data:
  name=item['Name'].lstrip('/');images[name]=item['Image']
  for i,mount in enumerate(item['Mounts']):
   if mount['Type']=='volume' and mount['Destination']!='/app/backups':sources[name+'-'+pathlib.PurePosixPath(mount['Destination']).name]=pathlib.Path(mount['Source'])
 repo=pathlib.Path(repository)
 for label,relative in [('workspace-env','.env'),('frp-env','tools/frp/.env'),('voice-env','tools/voice/.env'),('video-env','tools/video/.env'),('firmware-env','tools/firmware/.env')]:
  if not (repo/relative).is_file():raise ValueError('Missing configuration: '+label)
  sources[label]=repo/relative
 for label,location in [('lampac-config','/opt/lampac/init.conf'),('lampac-database','/opt/lampac/database'),('torrserver-access','/opt/lampac/data/ts/accs.db'),('caddy-config','/etc/caddy/Caddyfile'),('lampac-unit','/etc/systemd/system/lampac-workspace.service')]:
  p=pathlib.Path(location)
  if p.exists():sources[label]=p
 return sources,images

def source_files(source):
 if source.is_file():yield pathlib.Path(source.name),source;return
 for p in sorted(source.rglob('*')):
  if p.is_symlink() or not p.is_file() or p.name.endswith(('-wal','-shm','.tmp')):continue
  relative=p.relative_to(source)
  # Generated video/audio media expires independently; back up state and durable inboxes instead.
  if relative.parts[0] in ['files','tmp','cache','workspace-cache']:continue
  yield relative,p

def put_object(source,objects,temporary):
 with source.open('rb') as handle:is_sqlite=handle.read(16)==b'SQLite format 3\x00'
 actual=source
 if is_sqlite:
  actual=temporary/'database.db'
  with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as original,sqlite3.connect(actual) as copied:
   original.backup(copied)
   if copied.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('SQLite integrity failure')
 digest=hashlib.sha256();tmp=temporary/'object'
 before=actual.stat()
 with actual.open('rb') as reader,tmp.open('wb') as writer:
  for chunk in iter(lambda:reader.read(1024*1024),b''):digest.update(chunk);writer.write(chunk)
 after=actual.stat()
 if (before.st_size,before.st_mtime_ns,before.st_ino)!=(after.st_size,after.st_mtime_ns,after.st_ino):raise ValueError('Source changed during snapshot; retry later')
 key=digest.hexdigest();target=objects/key
 if not target.exists():tmp.chmod(0o600);os.replace(tmp,target)
 else:tmp.unlink()
 if is_sqlite:actual.unlink()
 return {'sha256':key,'size':after.st_size,'sqlite':is_sqlite}

def verify(destination,manifest):
 objects=destination/'objects';checked=set()
 for item in manifest['files']:
  key=item['sha256']
  if not HEX.fullmatch(key):raise ValueError('Invalid object identifier')
  if key in checked:continue
  p=objects/key
  if p.stat().st_size!=item['size']:raise ValueError('Backup object size mismatch')
  h=hashlib.sha256()
  with p.open('rb') as f:
   for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
  if h.hexdigest()!=key:raise ValueError('Backup checksum mismatch')
  if item.get('sqlite'):
   with sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True) as db:
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Backup SQLite integrity failure')
  checked.add(key)
 return len(checked)

def snapshot(destination,sources,retain=7,images=None):
 destination=pathlib.Path(destination).resolve();private_dir(destination)
 objects=destination/'objects';manifests=destination/'snapshots';private_dir(objects);private_dir(manifests)
 with (destination/'snapshot.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  manifest={'schema':1,'createdAt':now(),'images':images or {},'files':[],'components':sorted(sources)}
  with tempfile.TemporaryDirectory(dir=destination) as tmp:
   for label,raw in sources.items():
    if not re.fullmatch(r'[a-zA-Z0-9_-]+',label):raise ValueError('Invalid component')
    source=pathlib.Path(raw).resolve()
    if not source.exists():raise ValueError('Missing backup source')
    if source.is_dir() and destination.is_relative_to(source):raise ValueError('Backup overlaps source')
    for relative,p in source_files(source):manifest['files'].append({'path':label+'/'+relative.as_posix(),'uid':p.stat().st_uid,'gid':p.stat().st_gid,'mode':p.stat().st_mode&0o777,**put_object(p,objects,pathlib.Path(tmp))})
  manifest['uniqueObjects']=verify(destination,manifest);manifest['bytes']=sum(item['size'] for item in manifest['files'])
  name=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json';atomic_json(manifests/name,manifest)
  saved=sorted(manifests.glob('*.json'));keep=saved[-max(1,retain):]
  referenced={item['sha256'] for m in keep for item in json.loads(m.read_text())['files']}
  for m in saved[:-max(1,retain)]:m.unlink()
  for obj in objects.iterdir():
   if HEX.fullmatch(obj.name) and obj.name not in referenced:obj.unlink()
  return name,manifest

def restore(destination,manifest,target):
 target=pathlib.Path(target).resolve()
 if target.exists() and any(target.iterdir()):raise ValueError('Restore target must be empty staging directory')
 # A restore never writes directly into working services or a system root.
 if any(target==p or target.is_relative_to(p) for p in map(pathlib.Path,['/root/support_chat','/var/lib/docker','/opt/lampac','/etc'])) or target==pathlib.Path('/'):
  raise ValueError('Restore into a separate staging directory')
 for item in manifest['files']:
  relative=pathlib.PurePosixPath(item['path'])
  if relative.is_absolute() or '..' in relative.parts or not relative.parts:raise ValueError('Invalid restore path')
 verify(destination,manifest);private_dir(target)
 for item in manifest['files']:
  relative=pathlib.PurePosixPath(item['path'])
  if relative.is_absolute() or '..' in relative.parts:raise ValueError('Invalid restore path')
  file=target/relative;file.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(destination/'objects'/item['sha256'],file);file.chmod(0o600)
 return len(manifest['files'])

def main():
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['snapshot','verify','restore']);parser.add_argument('--destination',default=DEFAULT_DEST);parser.add_argument('--repository',default='/root/support_chat');parser.add_argument('--manifest');parser.add_argument('--restore-to');parser.add_argument('--retain',type=int,default=7);parser.add_argument('--status',default=STATUS);args=parser.parse_args()
 destination=pathlib.Path(args.destination).resolve()
 try:
  if args.action=='snapshot':
   sources,images=discover(args.repository);name,data=snapshot(destination,sources,args.retain,images)
   status={'ok':True,'lastSuccessAt':now(),'components':data['components'],'files':len(data['files']),'bytes':data['bytes'],'verified':True,'external':False,'manifest':name};atomic_json(args.status,status,0o644);print(json.dumps({k:v for k,v in status.items() if k!='manifest'}));return
  saved=sorted((destination/'snapshots').glob('*.json'));name=args.manifest or (saved[-1].name if saved else '')
  if pathlib.Path(name).name!=name:raise ValueError('Invalid snapshot name')
  data=json.loads((destination/'snapshots'/name).read_text())
  if args.action=='verify':print(json.dumps({'verifiedObjects':verify(destination,data)}))
  else:
   if not args.restore_to:raise ValueError('Provide an empty --restore-to staging directory')
   print(json.dumps({'restoredFiles':restore(destination,data,args.restore_to)}))
 except Exception as error:
  if args.action=='snapshot':
   try:previous=json.loads(pathlib.Path(args.status).read_text())
   except (OSError,ValueError):previous={}
   atomic_json(args.status,{**previous,'ok':False,'checkedAt':now(),'error':'Резервное копирование не завершено. Проверьте журнал службы.'},0o644)
  raise SystemExit(type(error).__name__+': '+str(error))
if __name__=='__main__':main()
