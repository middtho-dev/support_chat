"""Device-scoped credentials and short-lived pairing codes for the Workspace plugin."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import closing
import advanced

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def database(root):
    directory=root/'database/workspace'
    directory.mkdir(parents=True,exist_ok=True)
    conn=sqlite3.connect(directory/'devices.db',timeout=3)
    conn.row_factory=sqlite3.Row
    conn.execute('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, credential TEXT UNIQUE, code TEXT UNIQUE, expires REAL, paired INTEGER DEFAULT 0, name TEXT, ip TEXT, last REAL, desired TEXT DEFAULT \'{}\', revision INTEGER DEFAULT 0, applied INTEGER DEFAULT 0, snapshot TEXT DEFAULT \'{}\', reload INTEGER DEFAULT 0)')
    conn.execute('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start REAL, attempts INTEGER)')
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
    if not isinstance(body,dict) or len(body)>len(advanced.CLIENT):
        raise ValueError('Некорректные настройки устройства')
    for key,value in body.items():
        if key not in advanced.CLIENT or not isinstance(value,str) or value not in (advanced.CLIENT[key][1] or {'true':1,'false':1}):
            raise ValueError('Недоступный параметр устройства')
    return body

def public(root,action,body,ip):
    ip=advanced.address(ip)
    with closing(database(root)) as conn, conn:
        conn.execute('DELETE FROM devices WHERE paired=0 AND expires<?',(time.time(),))
        if action=='register':
            if set(body)!={'name'} or not isinstance(body['name'],str) or not 1<=len(body['name'])<=80:
                raise ValueError('Название устройства: 1–80 символов')
            limit(conn,'register:'+ip,3)
            token=secrets.token_urlsafe(32);code=str(secrets.randbelow(100000000)).zfill(8)
            conn.execute('INSERT INTO devices (id,credential,code,expires,name,ip,last) VALUES (?,?,?,?,?,?,?)',
                (secrets.token_hex(12),digest(token),digest(code),time.time()+300,body['name'],ip,time.time()))
            return {'token':token,'code':code,'expiresIn':300}
        if action!='poll' or set(body)!={'token','applied','snapshot'} or not isinstance(body['token'],str) or not 32<=len(body['token'])<=100 or type(body['applied']) is not int:
            raise ValueError('Некорректный запрос устройства')
        snapshot=values(body['snapshot'])
        row=conn.execute('SELECT * FROM devices WHERE credential=?',(digest(body['token']),)).fetchone()
        if not row:
            raise PermissionError('Привязка истекла или отозвана')
        limit(conn,'poll:'+row['id'],30)
        applied=row['applied']
        if body['applied']==row['revision']:
            applied=body['applied']
        conn.execute('UPDATE devices SET last=?,ip=?,snapshot=?,applied=? WHERE id=?',
            (time.time(),ip,json.dumps(snapshot),applied,row['id']))
        return {'paired':bool(row['paired']),'revision':row['revision'],
                'values':json.loads(row['desired']) if row['paired'] and applied<row['revision'] else {},
                'reload':bool(row['reload']) if row['paired'] and applied<row['revision'] else False}

def listing(root):
    with closing(database(root)) as conn:
        return {'devices':[{**{k:row[k] for k in ['id','name','ip','last','revision','applied']},
                            'snapshot':json.loads(row['snapshot']),'desired':json.loads(row['desired'])}
                           for row in conn.execute('SELECT * FROM devices WHERE paired=1 ORDER BY last DESC')],
                'fields':advanced.client_settings({})['fields']}

def manage(root,body):
    if not isinstance(body,dict):
        raise ValueError('Нужен объект')
    action=body.get('action')
    with closing(database(root)) as conn, conn:
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
        elif action=='configure' and set(body)=={'action','id','values','reload'} and type(body['reload']) is bool:
            patch=values(body['values'])
            if row['applied']<row['revision']:
                raise ValueError('Дождитесь подтверждения предыдущей команды от ТВ')
            if not patch and not body['reload']:
                raise ValueError('Нет изменений')
            conn.execute('UPDATE devices SET desired=?,revision=revision+1,reload=? WHERE id=?',
                         (json.dumps(patch),int(body['reload']),row['id']))
        else:
            raise ValueError('Недопустимая команда')
        return {'ok':True}
