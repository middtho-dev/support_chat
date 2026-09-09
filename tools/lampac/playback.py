"""Bounded, device-authenticated current playback snapshots, not viewing history."""
import json
import math
import re
import time

STATES = {'idle', 'loading', 'playing', 'paused', 'buffering', 'ended', 'error'}
METHODS = {'unknown', 'browser', 'browser-hls', 'native'}
ERRORS = {'', 'aborted', 'network', 'decode', 'unsupported', 'player'}

def schema(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS playback (device TEXT, session TEXT, updated REAL, data TEXT, PRIMARY KEY(device,session))')

def clean(body):
    if not isinstance(body, dict) or set(body) != {'session','state','title','source','hash','method','position','duration','buffer','error'}:
        raise ValueError('Некорректная диагностика')
    if not isinstance(body['session'], str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,64}',body['session']):
        raise ValueError('Некорректный сеанс')
    for key, choices in [('state',STATES),('method',METHODS),('error',ERRORS)]:
        if not isinstance(body[key],str) or body[key] not in choices:raise ValueError('Некорректный статус')
    for key, maximum in [('title',200),('source',253),('hash',40)]:
        value=body[key]
        if not isinstance(value,str) or len(value)>maximum or any(ord(c)<32 for c in value):raise ValueError('Некорректное поле')
    if body['hash'] and not re.fullmatch(r'[a-fA-F0-9]{40}',body['hash']):raise ValueError('Некорректный hash')
    if body['source'] and not re.fullmatch(r'[a-zA-Z0-9.:[\]-]+',body['source']):raise ValueError('Только имя источника')
    if re.search(r'https?://|[?&](?:token|password|key)=',body['title'],re.I):raise ValueError('URL не является названием')
    for key in ['position','duration','buffer']:
        value=body[key]
        if value is not None and (type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=604800):raise ValueError('Некорректное время')
    return dict(body,hash=body['hash'].lower())

def record(conn, device, body):
    data=clean(body)
    schema(conn)
    now=time.time()
    conn.execute('DELETE FROM playback WHERE updated<?',(now-86400,))
    conn.execute('INSERT OR REPLACE INTO playback VALUES (?,?,?,?)',(device,data['session'],now,json.dumps(data)))
    conn.execute('DELETE FROM playback WHERE device=? AND session NOT IN (SELECT session FROM playback WHERE device=? ORDER BY updated DESC LIMIT 8)',(device,device))

def listing(conn):
    schema(conn)
    now=time.time()
    conn.execute('DELETE FROM playback WHERE updated<?',(now-86400,))
    rows=conn.execute('SELECT p.*,d.name,d.enabled FROM playback p JOIN devices d ON d.id=p.device WHERE p.updated>? ORDER BY p.updated DESC LIMIT 500',(now-86400,))
    return [{**json.loads(r['data']),'device':r['device'],'name':r['name'],'updated':r['updated'],
             'fresh':now-r['updated']<90,'enabled':bool(r['enabled'])} for r in rows]
