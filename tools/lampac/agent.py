"""Loopback-only Lampac management. Run as lampac, never as root."""
import html
import copy
import base64
import hmac
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
import advanced
import devices
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ.get('LAMPAC_DIR', '/opt/lampac'))
TOKEN = os.environ.get('LAMPAC_SERVICE_TOKEN', '')
PUBLIC_URL = os.environ.get('LAMPAC_PUBLIC_URL', 'https://lc.kv9.ru')
LOCK = threading.Lock()
MODULES = ['TorrServer', 'DLNA', 'Sync', 'TimeCode']
TS_NUMBERS = {'CacheSize': (16 * 1048576, 2048 * 1048576), 'ConnectionsLimit': (1, 500), 'ReaderReadAHead': (5, 100), 'PreloadCache': (0, 100), 'DownloadRateLimit': (0, 1000000), 'UploadRateLimit': (0, 1000000)}
TS_BOOLS = ['DisableUpload', 'DisableDHT', 'DisablePEX', 'EnableIPv6', 'ForceEncrypt', 'UseDisk', 'RemoveCacheOnDrop']

def command(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=25, check=True).stdout.strip()

def read_config(name):
    path = ROOT / name
    if not path.exists():
        return {}
    result = json.loads(path.read_text())
    if not isinstance(result, dict):
        raise ValueError('Конфигурация должна быть объектом JSON')
    return result

def merge(base, patch):
    result = copy.deepcopy(base)
    for key, value in patch.items():
        result[key] = merge(result.get(key, {}), value) if isinstance(value, dict) and isinstance(result.get(key, {}), dict) else value
    return result

def settings(config):
    return {'name': config.get('online', {}).get('name', 'Lampac'),
            'lowMemory': config.get('lowMemoryMode', False),
            'chromium': config.get('chromium', {}).get('enable', True),
            'timeout': config.get('listen', {}).get('ResponseCancelAfter', 10),
            'modules': {name: name not in config.get('BaseModule', {}).get('SkipModules', []) for name in MODULES}}

def patch_config(config, values):
    if set(values) != {'name', 'lowMemory', 'chromium', 'timeout', 'modules'}:
        raise ValueError('Недопустимые поля настроек')
    if not isinstance(values['name'], str) or not 1 <= len(values['name'].strip()) <= 80:
        raise ValueError('Название: от 1 до 80 символов')
    if any(type(values[k]) is not bool for k in ('lowMemory', 'chromium')):
        raise ValueError('Некорректный переключатель')
    if type(values['timeout']) is not int or not 5 <= values['timeout'] <= 120:
        raise ValueError('Таймаут: от 5 до 120 секунд')
    if not isinstance(values['modules'], dict) or set(values['modules']) != set(MODULES) or any(type(v) is not bool for v in values['modules'].values()):
        raise ValueError('Некорректные модули')
    skip = [name for name in config.get('BaseModule', {}).get('SkipModules', []) if name not in MODULES]
    skip.extend(name for name, enabled in values['modules'].items() if not enabled)
    return merge(config, {'online': {'name': values['name'].strip()}, 'lowMemoryMode': values['lowMemory'],
                          'BaseModule': {'SkipModules': skip},
                          'chromium': {'enable': values['chromium']}, 'listen': {'ResponseCancelAfter': values['timeout']}})

def torr_request(body, path='/settings'):
    if path not in ('/settings', '/torrents'):
        raise ValueError('Unsupported TorrServer endpoint')
    config = merge(read_config('current.conf'), read_config('init.conf'))
    port = int(config.get('TorrServer', {}).get('tsport', 9085))
    passwd = json.loads((ROOT / 'data/ts/accs.db').read_text())['ts']
    headers = {'Content-Type': 'application/json', 'Authorization': 'Basic ' + base64.b64encode(('ts:' + passwd).encode()).decode()}
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + path, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise RuntimeError('TorrServer response too large')
        return json.loads(raw) if raw else {}

def torr_patch(current, values):
    if set(values) != set(TS_NUMBERS) | set(TS_BOOLS):
        raise ValueError('Недопустимые поля TorrServer')
    for key, (low, high) in TS_NUMBERS.items():
        if type(values[key]) is not int or not low <= values[key] <= high:
            raise ValueError('Некорректное число TorrServer')
    if any(type(values[k]) is not bool for k in TS_BOOLS):
        raise ValueError('Некорректный переключатель TorrServer')
    return {**current, **values}

def torr_pids():
    expected = (ROOT / 'data/ts/TorrServer-linux').resolve()
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid == os.getuid() and (entry / 'exe').resolve() == expected:
                found.append(int(entry.name))
        except (OSError, RuntimeError):
            pass
    return found

def restart_torrserver():
    previous = torr_pids()
    if not previous:
        raise RuntimeError('TorrServer process is absent')
    for pid in previous:
        os.kill(pid, signal.SIGTERM)
    # Lampac owns this child and restarts it after a ten-second delay.
    deadline = time.monotonic() + 22
    while time.monotonic() < deadline:
        time.sleep(0.5)
        if set(torr_pids()) - set(previous):
            try:
                torr_request({'action': 'get'})
                return
            except Exception:
                pass
    raise RuntimeError('TorrServer did not restart')

def save_config(config):
    target = ROOT / 'init.conf'
    backup = ROOT / 'database/backup/workspace'
    backup.mkdir(parents=True, exist_ok=True)
    if target.exists():
        dest = backup / (str(time.time_ns()) + '.json')
        dest.write_bytes(target.read_bytes())
        dest.chmod(0o600)
    fd, temp = tempfile.mkstemp(prefix='.workspace-', dir=ROOT)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(config, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def status():
    props = command('/usr/bin/systemctl', 'show', 'lampac.service', '--property=ActiveState,SubState,UnitFileState,MemoryCurrent,ActiveEnterTimestamp')
    service = dict(line.split('=', 1) for line in props.splitlines() if '=' in line)
    config = merge(read_config('current.conf'), read_config('init.conf'))
    port = int(config.get('listen', {}).get('port', 9118))
    healthy = False
    if service.get('ActiveState') == 'active':
        try:
            with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/', timeout=2) as r:
                healthy = r.status == 200
        except Exception:
            pass
    return {'service': service, 'healthy': healthy, 'settings': settings(config), 'url': PUBLIC_URL,
            'internal': '127.0.0.1:' + str(port), 'configPath': str(ROOT / 'init.conf'),
            'version': (ROOT / 'version.txt').read_text().strip()[:80], 'busy': LOCK.locked()}

def activation_page():
    support=os.environ.get('WORKSPACE_SUPPORT_URL','https://helpo.su').rstrip('/')
    logo=os.environ.get('WORKSPACE_LOGO_URL',support+'/logo.png')
    return (Path(__file__).parent/'activation.html').read_text(encoding='utf-8').replace('SUPPORT_URL',html.escape(support,quote=True)).replace('LOGO_URL',html.escape(logo,quote=True))


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_):
        pass

    def reply(self, code, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        return bool(TOKEN) and hmac.compare_digest(self.headers.get('x-admin-token', '').encode(), TOKEN.encode())

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'error': 'Требуется вход'})
        # Caddy's auth rewrite retains the original query string (e.g. ?v=...).
        self.path = self.path.split('?', 1)[0]
        if self.path not in ['/api/lampac', '/api/lampac/torrserver', '/api/lampac/advanced', '/api/lampac/torrents', '/api/lampac/clients', '/api/lampac/devices', '/access', '/client.js']:
            return self.reply(404, {'error': 'Неизвестный запрос'})
        try:
            if self.path == '/access':
                allowed = advanced.access(ROOT, self.headers.get('X-Workspace-IP', ''), self.headers.get('X-Workspace-UA', ''), self.headers.get('X-Workspace-URI', '/'))
                original=self.headers.get('X-Workspace-URI','/').split('?',1)[0]
                if allowed and not original.startswith('/workspace-device/') and original!='/workspace-client.js':
                    allowed=devices.access_allowed(ROOT,self.headers.get('Cookie',''))
                if not allowed and original in ('/','/index.html'):
                    payload=activation_page().encode()
                    self.send_response(403)
                    self.send_header('Content-Type','text/html; charset=utf-8')
                    self.send_header('Cache-Control','no-store')
                    self.send_header('Content-Length',str(len(payload)))
                    self.end_headers();self.wfile.write(payload)
                    return
                self.reply(200 if allowed else 403, {} if allowed else {'error': 'Доступ к Lampac отключён'})
            elif self.path == '/client.js':
                client = {'activation':activation_page().split('<!--SCREEN-->')[1].split('<!--POLL-->')[0], 'url': PUBLIC_URL.rstrip('/'), 'fields': {k:list(v[1] or {'true':1,'false':1}) for k,v in advanced.CLIENT.items()}}
                script = (advanced.client_script(read_config('init.conf')) + '\n' + (Path(__file__).parent/'device-client.js').read_text(encoding='utf-8').replace('DEVICE_CONFIG',json.dumps(client))).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(script)))
                self.end_headers()
                self.wfile.write(script)
            elif self.path.endswith('/devices'):
                self.reply(200, devices.listing(ROOT))
            elif self.path.endswith('/advanced'):
                config = merge(read_config('current.conf'), read_config('init.conf'))
                self.reply(200, {'fields': advanced.fields(config), 'client': advanced.client_settings(config)})
            elif self.path.endswith('/torrents'):
                self.reply(200, {'torrents': advanced.torrents(torr_request)})
            elif self.path.endswith('/clients'):
                self.reply(200, advanced.clients(ROOT))
            elif self.path.endswith('/torrserver'):
                values = torr_request({'action': 'get'})
                self.reply(200, {key: values.get(key, False if key in TS_BOOLS else 0) for key in [*TS_NUMBERS, *TS_BOOLS]})
            else:
                self.reply(200, status())
        except Exception:
            self.reply(502, {'error': 'Не удалось прочитать состояние Lampac. Проверьте службу и JSON-конфигурацию.'})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {'error': 'Требуется вход'})
        if self.path in ['/workspace-device/register', '/workspace-device/enroll', '/workspace-device/poll']:
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8192:
                    raise ValueError('Некорректный размер запроса')
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict):
                    raise ValueError('Нужен объект')
                if self.path.endswith(('/enroll','/register')) and not devices.access_allowed(ROOT,self.headers.get('Cookie','')):
                    return self.reply(403, {'error':'Доступ устройства отключён'})
                return self.reply(200, devices.public(ROOT, self.path.rsplit('/',1)[1], body, self.headers.get('X-Workspace-IP','')))
            except PermissionError:
                return self.reply(403, {'error':'Привязка истекла или отозвана'})
            except ValueError:
                return self.reply(400, {'error':'Проверьте запрос или подождите минуту перед повтором'})
            except Exception:
                return self.reply(502, {'error':'Управление устройствами временно недоступно'})
        if self.path not in ['/api/lampac/action', '/api/lampac/configure', '/api/lampac/torrserver', '/api/lampac/advanced', '/api/lampac/client', '/api/lampac/torrents', '/api/lampac/clients', '/api/lampac/devices']:
            return self.reply(404, {'error': 'Неизвестный запрос'})
        if not LOCK.acquire(blocking=False):
            return self.reply(409, {'error': 'Дождитесь завершения предыдущей операции'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 131072:
                raise ValueError('Некорректный размер запроса')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Нужен объект JSON')
            if self.path.endswith('/devices'):
                return self.reply(200, devices.manage(ROOT, body))
            if self.path.endswith('/advanced') or self.path.endswith('/client'):
                if (ROOT / 'init.yaml').exists():
                    raise ValueError('Обнаружен init.yaml; требуется JSON-конфигурация')
                original = read_config('init.conf')
                effective = merge(read_config('current.conf'), original)
                updated = advanced.apply_client(original, effective, body, PUBLIC_URL) if self.path.endswith('/client') else advanced.apply_fields(original, effective, body)
                if updated != original:
                    save_config(updated)
            elif self.path.endswith('/torrents'):
                advanced.torrent_action(torr_request, body)
            elif self.path.endswith('/clients'):
                advanced.block(ROOT, body)
            elif self.path.endswith('/action'):
                action = body.get('action')
                if set(body) != {'action'} or action not in ['start', 'stop', 'restart', 'enable', 'disable', 'torr-restart']:
                    raise ValueError('Неизвестная команда')
                if action == 'torr-restart':
                    restart_torrserver()
                else:
                    command('/usr/bin/sudo', '-n', '/usr/bin/systemctl', action, 'lampac.service')
            elif self.path.endswith('/torrserver'):
                previous = torr_request({'action': 'get'})
                updated = torr_patch(previous, body)
                if all(previous.get(k) == v for k, v in body.items()):
                    return self.reply(200, {'ok': True, 'unchanged': True})
                if updated['UseDisk'] and not updated.get('TorrentsSavePath'):
                    cache = ROOT / 'data/ts/workspace-cache'
                    cache.mkdir(parents=True, exist_ok=True)
                    updated['TorrentsSavePath'] = str(cache)
                backup = ROOT / 'database/backup/workspace'
                backup.mkdir(parents=True, exist_ok=True)
                dest = backup / ('torrserver-' + str(time.time_ns()) + '.json')
                dest.write_text(json.dumps(previous)); dest.chmod(0o600)
                torr_request({'action': 'set', 'sets': updated})
                actual = torr_request({'action': 'get'})
                if any(actual.get(k) != v for k, v in body.items()):
                    raise RuntimeError('TorrServer did not confirm settings')
            else:
                if (ROOT / 'init.yaml').exists():
                    raise ValueError('Обнаружен init.yaml. Сначала перенесите его настройки в init.conf.')
                original = read_config('init.conf')
                # Preserve default SkipModules too; init.conf overrides this whole array.
                if 'SkipModules' not in original.get('BaseModule', {}):
                    original = merge(original, {'BaseModule': {'SkipModules': read_config('current.conf').get('BaseModule', {}).get('SkipModules', [])}})
                save_config(patch_config(original, body))
            self.reply(200, {'ok': True})
        except (ValueError, json.JSONDecodeError):
            self.reply(400, {'error': 'Проверьте типы и диапазоны полей. Адреса должны быть корректными, init.conf — JSON без комментариев; init.yaml не поддерживается.'})
        except Exception:
            self.reply(502, {'error': 'Операция не подтверждена. Обновите статус; проверьте службу и права доступа.'})
        finally:
            LOCK.release()

if __name__ == '__main__':
    if len(TOKEN) < 32:
        raise RuntimeError('LAMPAC_SERVICE_TOKEN must contain at least 32 characters')
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('LAMPAC_AGENT_PORT', '7600'))), Handler).serve_forever()
