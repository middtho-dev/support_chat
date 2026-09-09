"""Device-scoped credentials and short-lived pairing codes for the Workspace plugin."""
import hashlib
import json
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from contextlib import closing
import advanced
import playback

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def database(root):
    directory=root/'database/workspace'
    directory.mkdir(parents=True,exist_ok=True)
    conn=sqlite3.connect(directory/'devices.db',timeout=3)
    conn.row_factory=sqlite3.Row
    conn.execute('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, credential TEXT UNIQUE, code TEXT UNIQUE, expires REAL, paired INTEGER DEFAULT 0, name TEXT, ip TEXT, last REAL, desired TEXT DEFAULT \'{}\', revision INTEGER DEFAULT 0, applied INTEGER DEFAULT 0, snapshot TEXT DEFAULT \'{}\', reload INTEGER DEFAULT 0)')
    conn.execute('CREATE TABLE IF NOT EXISTS ui_controls (device TEXT,key TEXT,label TEXT,group_name TEXT,PRIMARY KEY(device,key))')
    conn.execute('CREATE TABLE IF NOT EXISTS ui_control_descriptions (device TEXT,key TEXT,description TEXT,PRIMARY KEY(device,key))')
    conn.execute('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start REAL, attempts INTEGER)')
    conn.execute('CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY,title TEXT,message TEXT,button TEXT,repeats INTEGER,interval_seconds INTEGER,created REAL,cancelled INTEGER DEFAULT 0)')
    conn.execute('CREATE TABLE IF NOT EXISTS announcement_deliveries (announcement TEXT,device TEXT,shown INTEGER DEFAULT 0,last REAL DEFAULT 0,PRIMARY KEY(announcement,device))')
    conn.execute('CREATE INDEX IF NOT EXISTS announcement_device ON announcement_deliveries(device)')
    if 'enabled' not in {r[1] for r in conn.execute('PRAGMA table_info(devices)')}:
        try:
            conn.execute('ALTER TABLE devices ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
            conn.commit()
        except sqlite3.OperationalError:
            if 'enabled' not in {r[1] for r in conn.execute('PRAGMA table_info(devices)')}:
                raise
    return conn

def limit(conn,key,maximum):
    now=time.time()
    row=conn.execute('SELECT * FROM limits WHERE key=?',(key,)).fetchone()
    if row and row['start']>now-60 and row['attempts']>=maximum:
        raise ValueError('Слишком много запросов. Подождите минуту.')
    if not row or row['start']<=now-60:
        conn.execute('INSERT OR REPLACE INTO limits VALUES (?,?,1)',(key,now))
    else:
        conn.execute('UPDATE limits SET attempts=attempts+1 WHERE key=?',(key,))
    conn.execute('DELETE FROM limits WHERE start<?',(now-600,))

def values(body):
    if not isinstance(body,dict) or len(body)>len(advanced.CLIENT)+500:
        raise ValueError('Некорректные настройки устройства')
    for key,value in body.items():
        if not advanced.valid_preference(key,value):
            raise ValueError('Недоступный параметр устройства')
    return body

def next_announcement(conn,device):
    row=conn.execute('SELECT a.*,d.shown FROM announcements a JOIN announcement_deliveries d ON a.id=d.announcement WHERE d.device=? AND a.cancelled=0 AND d.shown<a.repeats AND (d.shown=0 OR d.last+a.interval_seconds<=?) ORDER BY a.created,a.id LIMIT 1',(device,time.time())).fetchone()
    return {k:row[k] for k in ['id','title','message','button']}|{'occurrence':row['shown']+1} if row else None


def announce(conn,body):
    if set(body)!={'action','target','title','message','button','repeats','intervalMinutes'}:
        raise ValueError('Некорректное объявление')
    for key,maximum in [('title',120),('message',5000),('button',60)]:
        value=body[key]
        if not isinstance(value,str) or not 1<=len(value.strip())<=maximum or any(ord(c)<32 and (key!='message' or c not in '\n\t') for c in value):
            raise ValueError('Проверьте текст объявления')
    if type(body['repeats']) is not int or not 1<=body['repeats']<=100 or type(body['intervalMinutes']) is not int or not 1<=body['intervalMinutes']<=10080:
        raise ValueError('Показы: 1–100; интервал: 1–10080 минут')
    if not isinstance(body['target'],str):raise ValueError('Нужен получатель')
    recipients=[r[0] for r in conn.execute('SELECT id FROM devices WHERE paired=1'+('' if body['target']=='all' else ' AND id=?'),() if body['target']=='all' else (body['target'],))]
    if not recipients:raise ValueError('Нет устройств для отправки')
    identifier=secrets.token_hex(12)
    conn.execute('INSERT INTO announcements (id,title,message,button,repeats,interval_seconds,created) VALUES (?,?,?,?,?,?,?)',(identifier,body['title'].strip(),body['message'].strip(),body['button'].strip(),body['repeats'],body['intervalMinutes']*60,time.time()))
    conn.executemany('INSERT INTO announcement_deliveries (announcement,device) VALUES (?,?)',[(identifier,d) for d in recipients])
    return {'ok':True,'id':identifier,'recipients':len(recipients)}


def public(root,action,body,ip):
    ip=advanced.address(ip)
    with closing(database(root)) as conn, conn:
        conn.execute('DELETE FROM devices WHERE paired=0 AND expires<?',(time.time(),))
        if action in ('register','enroll'):
            if set(body)!={'name'} or not isinstance(body['name'],str) or not 1<=len(body['name'])<=80:
                raise ValueError('Название устройства: 1–80 символов')
            limit(conn,'register:'+ip,3)
            token=secrets.token_urlsafe(32);code=str(secrets.randbelow(100000000)).zfill(8)
            identifier=secrets.token_hex(12)
            automatic=action=='enroll'
            conn.execute('INSERT INTO devices (id,credential,code,expires,name,ip,last,paired,enabled) VALUES (?,?,?,?,?,?,?,?,?)',
                (identifier,digest(token),None if automatic else digest(code),time.time()+300,body['name'],ip,time.time(),int(automatic),0))
            return {'id':identifier,'token':token,'code':None if automatic else code,'expiresIn':300,'paired':automatic,'enabled':False}
        if action=='heartbeat':
            if set(body)!={'token','playback'} or not isinstance(body['token'],str) or not 32<=len(body['token'])<=100:
                raise ValueError('Некорректный сигнал устройства')
            row=conn.execute('SELECT id,enabled FROM devices WHERE credential=? AND paired=1',(digest(body['token']),)).fetchone()
            if not row:raise PermissionError('Доступ отозван')
            limit(conn,'heartbeat:'+row['id'],40)
            playback.clean(body['playback'])
            if row['enabled']:playback.record(conn,row['id'],body['playback'])
            conn.execute('UPDATE devices SET last=?,ip=? WHERE id=?',(time.time(),ip,row['id']))
            return {'ok':True,'enabled':bool(row['enabled'])}
        if action=='announcement-ack':
            if set(body)!={'token','id','occurrence'} or not isinstance(body['token'],str) or not isinstance(body['id'],str) or type(body['occurrence']) is not int:
                raise ValueError('Некорректное подтверждение')
            row=conn.execute('SELECT id FROM devices WHERE credential=? AND paired=1 AND enabled=1',(digest(body['token']),)).fetchone()
            if not row:raise PermissionError('Доступ отозван')
            limit(conn,'ack:'+row['id'],30)
            conn.execute('UPDATE announcement_deliveries SET shown=?,last=? WHERE device=? AND announcement=? AND shown=? AND EXISTS (SELECT 1 FROM announcements a WHERE a.id=announcement AND a.cancelled=0 AND a.repeats>=? AND (shown=0 OR last+a.interval_seconds<=?))',(body['occurrence'],time.time(),row['id'],body['id'],body['occurrence']-1,body['occurrence'],time.time()))
            return {'ok':True}
        if action!='poll' or set(body) not in ({'token','applied','snapshot'},{'token','applied','snapshot','controls'}) or not isinstance(body['token'],str) or not 32<=len(body['token'])<=100 or type(body['applied']) is not int:
            raise ValueError('Некорректный запрос устройства')
        snapshot=values(body['snapshot'])
        row=conn.execute('SELECT * FROM devices WHERE credential=?',(digest(body['token']),)).fetchone()
        if not row:
            raise PermissionError('Привязка истекла или отозвана')
        limit(conn,'poll:'+row['id'],30)
        if 'controls' in body:
            controls=body['controls']
            if not isinstance(controls,list) or len(controls)>500:raise ValueError('Некорректный список пунктов')
            for item in controls:
                if not isinstance(item,dict) or set(item) not in ({'key','label','group'},{'key','label','group','description'}) or not advanced.dynamic_key(item['key']) or any(not isinstance(item[k],str) or not 1<=len(item[k])<=120 or any(ord(c)<32 for c in item[k]) for k in ['label','group']):raise ValueError('Некорректный пункт интерфейса')
                description=item.get('description','')
                if not isinstance(description,str) or len(description)>120 or any(ord(c)<32 for c in description):raise ValueError('Некорректное описание пункта')
            conn.execute('DELETE FROM ui_controls WHERE device=?',(row['id'],))
            conn.executemany('INSERT OR REPLACE INTO ui_controls VALUES (?,?,?,?)',[(row['id'],c['key'],c['label'],c['group']) for c in controls])
            conn.execute('DELETE FROM ui_control_descriptions WHERE device=?',(row['id'],))
            conn.executemany('INSERT OR REPLACE INTO ui_control_descriptions VALUES (?,?,?)',[(row['id'],c['key'],c.get('description','')) for c in controls])
        applied=row['applied']
        if body['applied']==row['revision']:
            applied=body['applied']
        conn.execute('UPDATE devices SET last=?,ip=?,snapshot=?,applied=? WHERE id=?',
            (time.time(),ip,json.dumps(snapshot) if snapshot else row['snapshot'],applied,row['id']))
        return {'id':row['id'],'name':row['name'],'enabled':bool(row['enabled']),
                'announcement':next_announcement(conn,row['id']) if row['paired'] and row['enabled'] else None,
                'overrides':advanced.normalize_preferences(json.loads(row['desired'])) if row['paired'] else {},
                'paired':bool(row['paired']),'revision':row['revision'],
                'values':advanced.normalize_preferences(json.loads(row['desired'])) if row['paired'] and applied<row['revision'] else {},
                'reload':bool(row['reload']) if row['paired'] and applied<row['revision'] else False}

def control_listing(root):
    with closing(database(root)) as conn:
        return [dict(key=r['key'],label=r['label'],group=r['group_name'],**({'description':r['description']} if r['description'] else {})) for r in conn.execute('SELECT c.key,MIN(c.label) AS label,MIN(c.group_name) AS group_name,MAX(d.description) AS description FROM ui_controls c LEFT JOIN ui_control_descriptions d ON c.device=d.device AND c.key=d.key GROUP BY c.key ORDER BY group_name,label LIMIT 1000')]

def listing(root):
    with closing(database(root)) as conn:
        return {'announcements':[dict(r) for r in conn.execute('SELECT a.*,COUNT(d.device) AS recipients,COALESCE(SUM(d.shown),0) AS shown FROM announcements a LEFT JOIN announcement_deliveries d ON d.announcement=a.id GROUP BY a.id ORDER BY a.created DESC LIMIT 50')], 'devices':[{**{k:row[k] for k in ['id','name','ip','last','revision','applied','enabled']},
                            'controls':[c['key'] for c in conn.execute('SELECT key FROM ui_controls WHERE device=?',(row['id'],))],
                            'snapshot':json.loads(row['snapshot']),'desired':advanced.normalize_preferences(json.loads(row['desired']))}
                           for row in conn.execute('SELECT * FROM devices WHERE paired=1 ORDER BY last DESC')],
                'fields':advanced.client_settings({},control_listing(root))['fields']}

def manage(root,body):
    if not isinstance(body,dict):
        raise ValueError('Нужен объект')
    action=body.get('action')
    with closing(database(root)) as conn, conn:
        if action=='announce':return announce(conn,body)
        if action=='announcement-cancel' and set(body)=={'action','id'}:
            if not isinstance(body['id'],str):raise ValueError('Нужен ID')
            conn.execute('UPDATE announcements SET cancelled=1 WHERE id=?',(body['id'],))
            return {'ok':True}
        if action=='pair':
            if set(body)!={'action','code'} or not isinstance(body['code'],str) or len(body['code'])!=8 or not body['code'].isascii() or not body['code'].isdigit():
                raise ValueError('Нужен восьмизначный код Workspace с экрана ТВ')
            limit(conn,'pair',10)
            # Commit attempts even when the submitted code is invalid.
            conn.commit()
            row=conn.execute('SELECT id FROM devices WHERE code=? AND paired=0 AND expires>?',(digest(body['code']),time.time())).fetchone()
            if not row:
                raise ValueError('Код не найден, уже использован или истёк')
            conn.execute('UPDATE devices SET paired=1,code=NULL WHERE id=?',(row['id'],))
            return {'ok':True}
        row=conn.execute('SELECT * FROM devices WHERE id=? AND paired=1',(body.get('id'),)).fetchone()
        if not row:
            raise ValueError('Устройство не найдено')
        if action=='revoke' and set(body)=={'action','id'}:
            conn.execute('DELETE FROM devices WHERE id=?',(row['id'],))
            playback.schema(conn)
            conn.execute('DELETE FROM playback WHERE device=?',(row['id'],))
            conn.execute('DELETE FROM ui_controls WHERE device=?',(row['id'],))
            conn.execute('DELETE FROM ui_control_descriptions WHERE device=?',(row['id'],))
        elif action=='rename' and set(body)=={'action','id','name'} and isinstance(body['name'],str) and 1<=len(body['name'].strip())<=80 and not any(ord(c)<32 for c in body['name']):
            conn.execute('UPDATE devices SET name=? WHERE id=?',(body['name'].strip(),row['id']))
        elif action=='access' and set(body)=={'action','id','enabled'} and type(body['enabled']) is bool:
            conn.execute('UPDATE devices SET enabled=? WHERE id=?',(int(body['enabled']),row['id']))
        elif action=='configure' and set(body) in ({'action','id','values','reload'},{'action','id','values','reload','inherit'}) and type(body['reload']) is bool:
            patch=advanced.normalize_preferences(values(body['values']))
            inherit=body.get('inherit',[])
            if not isinstance(inherit,list) or any(not isinstance(k,str) or (k not in advanced.CLIENT and not advanced.dynamic_key(k)) for k in inherit) or set(inherit)&set(patch):
                raise ValueError('Некорректное наследование параметров')
            inherit=[advanced.CONTROL_ALIASES.get(k,k) for k in inherit]
            if set(inherit)&set(patch):raise ValueError('Некорректное наследование параметров')
            if row['applied']<row['revision']:
                raise ValueError('Дождитесь подтверждения предыдущей команды от ТВ')
            if not patch and not inherit and not body['reload']:
                raise ValueError('Нет изменений')
            desired=advanced.normalize_preferences(json.loads(row['desired']))|patch
            for key in inherit:desired.pop(key,None)
            conn.execute('UPDATE devices SET desired=?,revision=revision+1,reload=? WHERE id=?',
                         (json.dumps(desired),int(body['reload']),row['id']))
        else:
            raise ValueError('Недопустимая команда')
        return {'ok':True}

def access_allowed(root,cookie_header,allow_unknown=False):
    cookies=SimpleCookie()
    try:cookies.load(cookie_header)
    except Exception:return True
    token=cookies.get('workspace_device')
    if not token:return True
    with closing(database(root)) as conn:
        row=conn.execute('SELECT enabled FROM devices WHERE credential=?',(digest(token.value),)).fetchone()
        return allow_unknown if row is None else bool(row['enabled'])

def playback_listing(root):
    with closing(database(root)) as conn, conn:
        return {'sessions':playback.listing(conn),'devices':[dict(r) for r in conn.execute('SELECT id,last,enabled FROM devices WHERE paired=1')],'serverTime':time.time()}

def playback_remove(root,body):
    with closing(database(root)) as conn, conn:
        return playback.remove(conn,body)
