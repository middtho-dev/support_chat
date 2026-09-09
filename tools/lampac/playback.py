"""Bounded, device-authenticated current playback snapshots, not viewing history."""
import json
import math
import re
import time

STATES = {'idle', 'loading', 'playing', 'paused', 'buffering', 'ended', 'error', 'external'}
METHODS = {'unknown', 'browser', 'browser-hls', 'native', 'external'}
STALE_SECONDS = 300
EXTERNAL_SECONDS = 12 * 3600
ERRORS = {'', 'aborted', 'network', 'decode', 'unsupported', 'player'}

def schema(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS playback (device TEXT, session TEXT, updated REAL, data TEXT, PRIMARY KEY(device,session))')

def poster(value):
    # Only catalogue image locations; never an arbitrary URL or credentialed proxy.
    if not isinstance(value,str) or len(value)>512:return ''
    if re.fullmatch(r'/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)',value):
        return 'https://image.tmdb.org/t/p/w300'+value
    match=re.fullmatch(r'https://image\.tmdb\.org/t/p/(?:w[0-9]+|original)(/[a-zA-Z0-9_-]+\.(?:jpg|png|webp))',value)
    if match:return 'https://image.tmdb.org/t/p/w300'+match[1]
    if re.fullmatch(r'https://(?:st\.kp\.yandex\.net|kinopoiskapiunofficial\.tech)/[a-zA-Z0-9/_-]+\.(?:jpg|png|webp)',value):return value
    return ''

def clean(body):
    if not isinstance(body, dict) or set(body)-{'poster'} != {'session','state','title','source','hash','method','position','duration','buffer','error'}:
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
    data=dict(body,hash=body['hash'].lower(),poster=poster(body.get('poster','')))
    if data['method']=='external':
        data.update(position=None,duration=None,buffer=None)
    return data

def record(conn, device, body):
    data=clean(body)
    schema(conn)
    now=time.time()
    purge(conn,now)
    if data['state'] in ('idle','ended'):
        conn.execute('DELETE FROM playback WHERE device=? AND session=?',(device,data['session']))
        return
    conn.execute('INSERT OR REPLACE INTO playback VALUES (?,?,?,?)',(device,data['session'],now,json.dumps(data)))
    conn.execute('DELETE FROM playback WHERE device=? AND session NOT IN (SELECT session FROM playback WHERE device=? ORDER BY updated DESC LIMIT 8)',(device,device))

def purge(conn,now):
    rows=conn.execute('SELECT device,session,updated,data FROM playback WHERE updated<?',(now-STALE_SECONDS,)).fetchall()
    for row in rows:
        if now-row['updated']>EXTERNAL_SECONDS or json.loads(row['data']).get('method')!='external':
            conn.execute('DELETE FROM playback WHERE device=? AND session=?',(row['device'],row['session']))

def listing(conn):
    schema(conn)
    now=time.time()
    purge(conn,now)
    rows=conn.execute('SELECT p.*,d.name,d.enabled FROM playback p JOIN devices d ON d.id=p.device WHERE p.updated>? ORDER BY p.updated DESC LIMIT 500',(now-EXTERNAL_SECONDS,))
    return [{**json.loads(r['data']),'device':r['device'],'name':r['name'],'updated':r['updated'],
             'fresh':now-r['updated']<90,'enabled':bool(r['enabled'])} for r in rows]

def remove(conn,body,protected=()):
    schema(conn)
    if not isinstance(body,dict):raise ValueError('Нужна команда')
    action=body.get('action')
    if action=='clear-inactive' and set(body)=={'action'}:
        rows=conn.execute('SELECT device,session,updated,data FROM playback').fetchall()
    elif action=='remove' and set(body)=={'action','device','session'} and all(isinstance(body[k],str) and 1<=len(body[k])<=64 for k in ['device','session']):
        rows=conn.execute('SELECT device,session,updated,data FROM playback WHERE device=? AND session=?',(body['device'],body['session'])).fetchall()
    else:raise ValueError('Некорректная команда')
    removed=0
    for row in rows:
        data=json.loads(row['data'])
        if (row['device'],row['session']) in protected:
            if action=='remove':raise ValueError('Поток активен. Обновите список.')
            continue
        if time.time()-row['updated']>=90 or data['state'] in ('idle','ended'):
            conn.execute('DELETE FROM playback WHERE device=? AND session=?',(row['device'],row['session']));removed+=1
        elif action=='remove':raise ValueError('Сеанс снова активен. Обновите список.')
    return {'ok':True,'removed':removed}


def correlate(result, torrents, readers):
    """Hash correlation is evidence of delivery, not a claim about rendered frames."""
    now=result['serverTime']; sessions=result['sessions']; matches={}
    for session in sessions:
        if session['enabled'] and session['hash']:
            matches.setdefault(session['hash'],[]).append(session)
    output=[]; linked=set()
    for session in sessions:
        torrent=torrents.get(session['hash'])
        session['streamActive']=False
        if session['method']=='external':
            active=readers.get(session['hash'],0)
            # Never assign a shared torrent's reader to one of several devices.
            if active and len(matches.get(session['hash'],[]))==1 and session['enabled']:
                session.update(fresh=True,streamActive=True,evidence='torrent-reader',streamChecked=now)
            elif now-session['updated']>=STALE_SECONDS:
                continue
        session['downloadSpeed']=torrent.get('download_speed') if torrent and session['fresh'] else None
        if session['enabled'] and (session['streamActive'] or (session['fresh'] and session['method']!='external')):
            linked.add(session['hash'])
        output.append(session)
    for key,count in readers.items():
        if not count or key in linked:continue
        torrent=torrents[key]
        output.append(dict(session='stream_'+key,device='',name='Устройство не определено',updated=now,
            fresh=True,enabled=True,state='playing',method='unknown',streamActive=True,evidence='torrent-reader',
            streamChecked=now,title=str(torrent.get('title') or torrent.get('name') or 'Торрент')[:200],
            hash=key,source='',poster=poster(torrent.get('poster','')),position=None,duration=None,buffer=None,error='',
            downloadSpeed=torrent.get('download_speed')))
    result['sessions']=output
    return result
