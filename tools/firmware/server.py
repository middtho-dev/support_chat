"""Private firmware worker; administrator authentication is also enforced by Workspace."""
import hmac,json,os,re,shutil,threading,time,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from image import inspect_image,MAX_IMAGE
from presets import validate
from builder import build
ROOT=Path(os.environ.get('FIRMWARE_DIR','/data'))
TOKEN=os.environ.get('FIRMWARE_SERVICE_TOKEN','')
LOCK=threading.Lock()
TTL=86400

def store(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');tmp.chmod(0o600);tmp.replace(path)

def record(kind,id):
    if not re.fullmatch('[a-f0-9]{32}',id):raise ValueError('Неверный ID')
    folder=ROOT/kind/id
    if not folder.is_dir():raise ValueError('Файл уже удалён или срок хранения истёк')
    return folder

def cleanup():
    for kind in ['images','jobs']:
        parent=ROOT/kind;parent.mkdir(parents=True,exist_ok=True)
        for folder in parent.iterdir():
            if folder.is_dir() and time.time()-folder.stat().st_mtime>TTL:shutil.rmtree(folder)

def status():
    def listing(kind):
        result=[]
        for p in (ROOT/kind).glob('*/status.json'):
            try:result.append(json.loads(p.read_text()))
            except (ValueError,OSError):pass
        return sorted(result,key=lambda x:x['created'],reverse=True)
    return {'images':listing('images'),'jobs':listing('jobs'),'busy':LOCK.locked(),'maxBytes':MAX_IMAGE,'retentionHours':24,'supported':'Xiaomi AX3000T · OpenWrt 25.12.x · squashfs sysupgrade'}

def work(folder,image_path,body):
    state={'id':folder.name,'created':time.time(),'state':'building','stage':'Подготовка'}
    def progress(stage):state['stage']=stage;store(folder/'status.json',state)
    try:
        result=build(image_path,body,folder/'firmware.bin',progress)
        state.update(state='ready',stage='Готово',result=result)
    except Exception as error:
        state.update(state='failed',stage='Сборка остановлена',error=str(error)[:2400])
        (folder/'firmware.bin').unlink(missing_ok=True)
    finally:
        body.clear();store(folder/'status.json',state);LOCK.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def setup(self):super().setup();self.connection.settimeout(120)
    def reply(self,code,data):
        raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def authorized(self):return bool(TOKEN) and hmac.compare_digest(self.headers.get('x-admin-token','').encode(),TOKEN.encode())
    def do_GET(self):
        if self.path=='/health':return self.reply(200,{'ok':True})
        if not self.authorized():return self.reply(401,{'error':'Требуется авторизация'})
        try:
            if self.path=='/':return self.reply(200,status())
            match=re.fullmatch(r'/jobs/([a-f0-9]{32})/download',self.path)
            if match:
                folder=record('jobs',match[1]);state=json.loads((folder/'status.json').read_text())
                if state['state']!='ready':raise ValueError('Образ ещё не готов')
                path=folder/'firmware.bin';self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Cache-Control','no-store');self.send_header('Content-Disposition','attachment; filename="'+state['result']['filename']+'"');self.send_header('Content-Length',str(path.stat().st_size));self.end_headers()
                with path.open('rb') as f:shutil.copyfileobj(f,self.wfile)
                return
            self.reply(404,{'error':'Неизвестная операция'})
        except (ValueError,OSError) as e:self.reply(400,{'error':str(e)})
    def do_POST(self):
        if not self.authorized():return self.reply(401,{'error':'Требуется авторизация'})
        acquired=False
        try:
            size=int(self.headers.get('Content-Length','0'))
            limit=MAX_IMAGE if self.path=='/images' else 16384
            if not 0<size<=limit:return self.reply(413,{'error':'Превышен размер запроса'})
            if self.path=='/images':
                if self.headers.get('Content-Type')!='application/octet-stream':return self.reply(415,{'error':'Нужен файл .bin'})
                acquired=LOCK.acquire(False)
                if not acquired:return self.reply(409,{'error':'Дождитесь текущей сборки'})
                cleanup()
                if len(list((ROOT/'images').iterdir()))>=2:raise ValueError('Можно хранить два исходных образа. Удалите ненужный')
                data=self.rfile.read(size)
                if len(data)!=size:raise ValueError('Файл загружен не полностью')
                info,_=inspect_image(data);folder=ROOT/'images'/uuid.uuid4().hex;folder.mkdir(mode=0o700)
                (folder/'input.bin').write_bytes(data);(folder/'input.bin').chmod(0o600)
                result={'id':folder.name,'created':time.time(),**info};store(folder/'status.json',result);return self.reply(201,result)
            if self.path=='/jobs':
                body=json.loads(self.rfile.read(size));validate(body)
                image=record('images',body.get('imageId',''))
                acquired=LOCK.acquire(False)
                if not acquired:return self.reply(409,{'error':'Уже идёт сборка'})
                cleanup()
                if len(list((ROOT/'jobs').iterdir()))>=2:raise ValueError('Можно хранить два результата. Удалите ненужный')
                folder=ROOT/'jobs'/uuid.uuid4().hex;folder.mkdir(mode=0o700)
                store(folder/'status.json',{'id':folder.name,'created':time.time(),'state':'building','stage':'Подготовка'})
                threading.Thread(target=work,args=(folder,image/'input.bin',body),daemon=True).start();acquired=False
                return self.reply(202,{'id':folder.name})
            return self.reply(404,{'error':'Неизвестная операция'})
        except Exception as error:self.reply(400,{'error':str(error)[:2400]})
        finally:
            if acquired:LOCK.release()
    def do_DELETE(self):
        if not self.authorized():return self.reply(401,{'error':'Требуется авторизация'})
        match=re.fullmatch('/(images|jobs)/([a-f0-9]{32})',self.path)
        if not match:return self.reply(404,{'error':'Неизвестная операция'})
        if not LOCK.acquire(False):return self.reply(409,{'error':'Дождитесь завершения сборки'})
        try:shutil.rmtree(record(match[1],match[2]));self.reply(200,{'ok':True})
        except Exception as error:self.reply(400,{'error':str(error)})
        finally:LOCK.release()

if __name__=='__main__':
    if len(TOKEN)<32 or TOKEN.startswith('replace-with-'):raise RuntimeError('Задайте FIRMWARE_SERVICE_TOKEN не менее 32 символов')
    ROOT.mkdir(parents=True,exist_ok=True);ROOT.chmod(0o700);cleanup()
    for path in (ROOT/'jobs').glob('*/status.json'):
        data=json.loads(path.read_text())
        if data['state']=='building':data.update(state='failed',error='Сервис перезапущен. Повторите сборку');store(path,data)
    def janitor():
        while True:
            time.sleep(600)
            if LOCK.acquire(False):
                try:cleanup()
                finally:LOCK.release()
    threading.Thread(target=janitor,daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0',7700),Handler).serve_forever()
