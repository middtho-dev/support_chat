"""Validated Lampac controls and observations from the trusted reverse proxy."""
import copy
from contextlib import closing
import hashlib
import ipaddress
import json
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

PLUGINS = dict(online='Онлайн-источники', torrserver='TorrServer', jacred='Поиск торрентов JacRed',
    catalog='Альтернативные каталоги', dorama='Дорамы', sisi='Раздел 18+', dlna='DLNA',
    tracks='Аудиодорожки', transcoding='Транскодирование', tmdbProxy='Прокси TMDB',
    cubProxy='Прокси CUB', sync='Синхронизация', bookmark='Закладки', timecode='Тайм-коды',
    backup='Резервные копии клиента', watch_together='Совместный просмотр', pirate_store='Магазин плагинов')
CLIENT = {
    'source': ('Каталог', {'tmdb':'TMDB', 'cub':'CUB'}),
    'start_page': ('Стартовая страница', {'main':'Главная', 'favorite@bookmarks':'Закладки', 'favorite@history':'История', 'mytorrents':'Мои торренты', 'last':'Последняя'}),
    'screensaver': ('Заставка', None),
    'screensaver_type': ('Вид заставки', {'nature':'Природа', 'chrome':'ChromeCast', 'aerial':'Aerial'}),
    'screensaver_time': ('Заставка через, минут', {str(n):str(n) for n in [1,2,5,10]}),
    'background': ('Фон', None),
    'background_type': ('Вид фона', {'simple':'Простой', 'complex':'Сложный', 'poster':'Постер'}),
    'animation': ('Анимация', None), 'advanced_animation': ('Расширенная анимация', None),
    'black_style': ('Чёрное оформление', None), 'glass_style': ('Стеклянное оформление', None),
    'light_version': ('Облегчённый интерфейс', None), 'card_quality': ('Качество на карточках', None),
    'card_episodes': ('Эпизоды на карточках', None), 'playlist_next': ('Следующая серия автоматически', None),
    'subtitles_start': ('Включать субтитры при запуске', None),
    'torrserver_savedb': ('Сохранять торренты в базе', None),
    'internal_torrclient': ('Встроенный торрент-клиент · Android / Android TV', None),
    'torrserver_preload': ('Предзагрузка торрентов', None),
    'torrserver_tracktimecode': ('Позиция просмотра TorrServer', None),
    'parser_use': ('Поиск торрентов: использовать парсер', None),
    'parse_in_search': ('Искать торренты в общем поиске', None),
    'cloud_use': ('Облачные торренты', None),
    'torrserver_gts': ('TorrServer: использовать глобальный сервер', None),
    'subtitles_stroke': ('Обводка субтитров', None),
    'subtitles_backdrop': ('Подложка субтитров', None),
    'player_normalization': ('Нормализация громкости', None),
    'player_external_fullscreen': ('Внешний плеер: полный экран', None),
    'proxy_tmdb': ('Прокси TMDB', None),
    'proxy_tmdb_auto': ('Автовыбор прокси TMDB', None),
    'proxy_other': ('Прокси других запросов', None),
    'helper': ('Подсказки управления', None),
    'mask': ('Маска интерфейса', None),
    'card_interfice_poster': ('Постер в карточке', None),
    'card_interfice_cover': ('Обложка в карточке', None),
    'card_interfice_reactions': ('Реакции в карточке', None),
    'hide_outside_the_screen': ('Скрывать элементы вне экрана', None),
    'cache_images': ('Кешировать изображения', None),
    'interface_sound_play': ('Звуки интерфейса', None),
    'menu_always': ('Постоянно показывать меню', None),
    'adult_content_view': ('Показывать контент 18+', None),
    **{'workspace_menu_'+key: ('Меню: '+label, None) for key,label in
       [('movie','фильмы'),('tv','сериалы'),('cartoon','мультфильмы'),('anime','аниме'),('catalog','каталог'),('history','история'),('favorite','избранное')]},
}
HEADER = {'profile':'Профиль CUB и предложение входа', 'search':'Поиск',
 'notice':'Уведомления', 'feed':'Лента', 'premium':'Предложение CUB Premium',
 'broadcast':'Трансляция', 'fullscreen':'Полноэкранный режим', 'clock':'Часы',
 'date':'Дата и день недели', 'logo':'Логотип Lampa'}
CLIENT.update({'workspace_header_'+k:(v,None) for k,v in HEADER.items()})
CLIENT.update({'interface_size':('Масштаб интерфейса',{'small':'Компактный','normal':'Обычный','bigger':'Крупный'}),
 'poster_size':('Качество постеров',{'w200':'Экономное','w300':'Обычное','w500':'Высокое'})})
HOME = {'source','start_page','interface_size','poster_size','background','background_type',
 'black_style','glass_style','light_version','card_quality','card_episodes','menu_always'}
HOME_STYLE = {
 'workspace_home_accent': ('Цвет акцента', {'native':'Как в Lampa','cyan':'KV9 · голубой','violet':'Фиолетовый','amber':'Янтарный','mint':'Мятный'}),
 'workspace_home_surface': ('Подложка верхней панели и меню', {'native':'Как в Lampa','glass':'Полупрозрачная','solid':'Тёмная'}),
 'workspace_home_corners': ('Скругление панелей', {'native':'Как в Lampa','soft':'Мягкое','square':'Прямое'}),
 'workspace_home_motion': ('Движение интерфейса', {'native':'Как в Lampa','reduced':'Минимум анимации'})}
CLIENT.update(HOME_STYLE)
HOME.update(HOME_STYLE)
HOME.update({'animation','advanced_animation','helper','interface_sound_play'})
PRESETS = [
 {'id':'kv9','name':'KV9','description':'Тёмное стекло, голубой акцент, спокойный интерфейс без CUB-профиля.', 'values':{'start_page':'main','black_style':'true','glass_style':'true','background':'true','background_type':'simple','interface_size':'normal','poster_size':'w500','workspace_home_accent':'cyan','workspace_home_surface':'glass','workspace_home_corners':'soft','workspace_home_motion':'reduced','workspace_header_profile':'false','workspace_header_premium':'false','workspace_header_clock':'true','workspace_header_search':'true'}},
 {'id':'cinema','name':'Кино','description':'Фон с постером, высокое качество обложек и минимум верхней панели.', 'values':{'start_page':'main','black_style':'true','glass_style':'false','background':'true','background_type':'poster','interface_size':'normal','poster_size':'w500','workspace_home_accent':'amber','workspace_home_surface':'solid','workspace_home_corners':'soft','workspace_home_motion':'native','workspace_header_profile':'false','workspace_header_premium':'false','workspace_header_clock':'false','workspace_header_search':'true'}},
 {'id':'compact','name':'Компактный','description':'Небольшие элементы и лёгкое оформление для монитора или слабого устройства.', 'values':{'start_page':'main','black_style':'true','glass_style':'false','background':'false','interface_size':'small','poster_size':'w300','workspace_home_accent':'mint','workspace_home_surface':'solid','workspace_home_corners':'square','workspace_home_motion':'reduced','workspace_header_profile':'false','workspace_header_premium':'false','workspace_header_clock':'true','workspace_header_search':'true'}},
 {'id':'tv','name':'Для ТВ','description':'Крупный интерфейс и заметный фокус для управления пультом.', 'values':{'start_page':'main','black_style':'true','glass_style':'false','background':'true','background_type':'simple','interface_size':'bigger','poster_size':'w500','workspace_home_accent':'cyan','workspace_home_surface':'solid','workspace_home_corners':'soft','workspace_home_motion':'reduced','workspace_header_profile':'false','workspace_header_premium':'false','workspace_header_clock':'true','workspace_header_search':'true'}}]
# Native component names come from Lampa Settings; unknown plugin sections use "other".
SETTINGS_SECTIONS = {'all':'Все настройки', 'account':'Аккаунт CUB', 'interface':'Интерфейс',
 'player':'Плеер', 'parser':'Поиск торрентов', 'server':'TorrServer', 'tmdb':'TMDB',
 'plugins':'Плагины', 'parental_control':'Родительский контроль', 'more':'Дополнительно',
 'workspace_device':'Workspace · информация', 'other':'Разделы других плагинов'}
CLIENT.update({'workspace_settings_'+k:(v,None) for k,v in SETTINGS_SECTIONS.items()})
BASICS = {'source','start_page','internal_torrclient','black_style','card_quality'}
def preference_meta(key):
    if key in HOME_STYLE:
        return {'group':'Главный экран','description':'Оформление Workspace применяется сразу после получения профиля. «Как в Lampa» убирает это переопределение.','global':True}
    if key.startswith('workspace_header_'):
        return {'group':'Верхняя панель', 'description':('Скрывает профиль, предложение Premium и раздел аккаунта CUB. Авторизация и данные аккаунта сохраняются; каталог CUB продолжает работать.' if key=='workspace_header_profile' else 'Показывать этот элемент вверху Lampa. Отсутствующий в вашей версии элемент не добавляется.'), 'global':True}
    if key.startswith('workspace_settings_'):
        return {'group':'Доступ к настройкам', 'description':'Включено — раздел доступен на устройстве. Выключено — скрыт и закрыт для перехода. Общий выключатель закрывает все разделы.', 'global':True}
    if key.startswith('workspace_menu_'):
        return {'group':'Левое меню', 'description':'Показывать этот пункт в левом меню Lampa. Не отключает сам источник контента.', 'global':True}
    if key.startswith('screensaver'):
        group='Заставка';help='Заставка появляется при бездействии. Вид и задержка действуют, когда заставка включена.'
    elif key.startswith('subtitles'):
        group='Субтитры';help='Настройка встроенного плеера. Наличие субтитров зависит от выбранного видео.'
    elif key.startswith(('torrserver','internal_','parser','parse_','cloud_')):
        group='Торренты';help='Поведение поиска и воспроизведения торрентов на этом устройстве.'
    elif key.startswith(('player','playlist')):
        group='Плеер';help='Поведение воспроизведения. Внешний плеер может использовать собственные настройки.'
    elif key.startswith('proxy'):
        group='Сеть';help='Проксирование запросов клиента Lampa; не изменяет VPN или прокси сервера Lampac.'
    elif key in ('source','start_page','adult_content_view'):
        group='Каталог';help='Каталог и начальный экран этого устройства.'
    else:
        group='Интерфейс';help='Оформление интерфейса Lampa. Некоторые изменения требуют перезапуска приложения.'
    descriptions = {
      'internal_torrclient':'Использовать торрент-движок приложения Android / Android TV. На других платформах нужен TorrServer; переключатель не устанавливает движок.',
      'torrserver_gts':'Использовать глобальный адрес TorrServer вместо локально заданного.',
      'torrserver_savedb':'Сохранять добавленные торренты в базе TorrServer.',
      'torrserver_preload':'Заранее набирать буфер перед началом воспроизведения.',
      'torrserver_tracktimecode':'Сохранять позицию просмотра для продолжения видео.',
      'playlist_next':'Автоматически запускать следующий элемент плейлиста после завершения текущего.',
      'light_version':'Упрощает оформление для устройств с ограниченной производительностью.',
      'cache_images':'Кешировать изображения на устройстве, чтобы реже загружать их повторно.',
      'screensaver_time':'Минуты бездействия до включения заставки.',
      'card_quality':'Показывать отметку качества видео на карточках.',
      'interface_sound_play':'Воспроизводить звуки при управлении интерфейсом.',
      'source':'Источник каталога фильмов и сериалов. Не меняет источники онлайн-видео.',
      'start_page':'Раздел, открываемый при запуске Lampa.',
      'black_style':'Использовать чёрную цветовую схему интерфейса.',
      'interface_size':'Размер элементов интерфейса: компактный для ПК или крупный для просмотра с расстояния. Требует перезапуска Lampa.',
      'poster_size':'Разрешение загружаемых постеров. Высокое качество требует больше трафика и памяти.'}
    return {'group':'Главный экран' if key in HOME else group, 'description':descriptions.get(key,help), 'global':key in BASICS or key in HOME}
PROVIDER = {
    'enable': ('Включён', 'bool'), 'displayname': ('Название в списке', 'text'),
    'displayindex': ('Порядок в списке', 'int', -1000, 10000),
    'host': ('Адрес источника', 'url'), 'httptimeout': ('Таймаут HTTP, секунд', 'int', 1, 120),
    'cache_time': ('Время кеша источника', 'int', 0, 1000000),
    'useproxy': ('Прокси для запросов', 'bool'), 'streamproxy': ('Проксировать видео', 'bool'),
    'useproxystream': ('Прокси при передаче видео', 'bool'), 'hls': ('Использовать HLS', 'bool'),
    'token': ('Токен · пустое поле сохраняет текущий', 'secret'),
    'login': ('Логин · пустое поле сохраняет текущий', 'secret'),
    'passwd': ('Пароль · пустое поле сохраняет текущий', 'secret'),
}

def fields(config):
    out = []
    def add(section, key, spec, group):
        value = config
        for part in (section+'.'+key).split('.'):
            if not isinstance(value, dict) or part not in value:
                return
            value = value[part]
        label, kind, *bounds = spec
        if kind == 'bool' and type(value) is not bool or kind == 'int' and type(value) is not int:
            return
        out.append(dict(path=section+'.'+key, label=label, kind=kind, group=group,
                        value='' if kind == 'secret' else value, configured=bool(value) if kind == 'secret' else False,
                        **({'min':bounds[0], 'max':bounds[1]} if bounds else {})))
    for key, label in PLUGINS.items():
        add('LampaWeb.initPlugins', key, (label, 'bool'), 'Плагины Lampa')
    for section, key, spec in [
        ('LampaWeb','autoupdate',('Автообновление Lampa','bool')),
        ('LampaWeb','intervalupdate',('Проверять обновления, минут','int',15,10080)),
        ('online','showquality',('Показывать качество источников','bool')),
        ('online','checkOnlineSearch',('Проверять онлайн-поиск','bool')),
        ('online','btn_priority_forced',('Приоритет кнопки онлайн','bool')),
        ('online','spider',('Агрегировать поиск Spider','bool')),
        ('online','version',('Показывать версию плагина','bool')),
        ('tmdb','cache_api',('Кеш TMDB API, минут','int',0,10080)),
        ('tmdb','cache_img',('Кеш изображений TMDB, минут','int',0,43200)),
    ]:
        add(section,key,spec,'Сервер и каталог')
    for section, values in sorted(config.items()):
        if isinstance(values,dict) and isinstance(values.get('plugin'),str) and 'displayindex' in values and 'enable' in values:
            for key, spec in PROVIDER.items():
                add(section,key,spec,'Источник · '+section)
    return out

def apply_fields(config, effective, values):
    if not isinstance(values,dict) or not values or len(values)>1500:
        raise ValueError('Выберите изменённые параметры')
    schema = {item['path']:item for item in fields(effective)}
    result = copy.deepcopy(config)
    for path,value in values.items():
        item = schema.get(path)
        if not item:
            raise ValueError('Недоступный параметр')
        kind = item['kind']
        if kind == 'bool' and type(value) is not bool:
            raise ValueError('Нужен переключатель')
        if kind == 'int' and (type(value) is not int or not item['min'] <= value <= item['max']):
            raise ValueError('Число вне диапазона')
        if kind in ('text','url','secret'):
            if not isinstance(value,str) or len(value)>2048 or any(ord(c)<32 for c in value):
                raise ValueError('Некорректный текст')
            if kind == 'url' and value:
                parsed=urlsplit(value)
                if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError('Нужен HTTP(S)-адрес без логина и пароля')
            if kind == 'secret' and not value:
                continue
        cursor=result
        parts=path.split('.')
        for part in parts[:-1]:
            cursor=cursor.setdefault(part,{})
        cursor[parts[-1]]=value
    return result

def client_settings(config):
    current=config.get('WorkspaceUI',{})
    return {'presets':copy.deepcopy(PRESETS), 'mode':current.get('mode','disabled'), 'values':current.get('values',{}),
            'fields':[{'key':k,'label':v[0],'options':v[1] or {'true':'Включено','false':'Выключено'}, **preference_meta(k)} for k,v in CLIENT.items()]}

def apply_client(config, effective, body, public_url):
    if set(body) != {'mode','values'} or body['mode'] not in ('disabled','revision','always') or not isinstance(body['values'],dict):
        raise ValueError('Некорректная политика клиента')
    for key,value in body['values'].items():
        if key not in CLIENT or not isinstance(value,str) or value not in (CLIENT[key][1] or {'true':1,'false':1}):
            raise ValueError('Недопустимое значение клиента')
    result=copy.deepcopy(config)
    result['WorkspaceUI']={**body,'revision':str(time.time_ns())}
    url=public_url.rstrip('/')+'/workspace-client.js'
    plugins=copy.deepcopy(effective.get('LampaWeb',{}).get('customPlugins') or [])
    plugins=[p for p in plugins if p.get('author')!='workspace-panel']
    # Keep the plugin enabled when policy is disabled, so it can release managed keys.
    plugins.append({'url':url,'name':'Workspace preferences','author':'workspace-panel','status':1})
    result.setdefault('LampaWeb',{})['customPlugins']=plugins
    return result

def client_script(config):
    policy=config.get('WorkspaceUI',{'mode':'disabled','values':{},'revision':'0'})
    # JSON is data, never interpolated into an executable string literal.
    return (Path(__file__).parent/'client-profile.js').read_text(encoding='utf-8').replace('POLICY',json.dumps(policy,ensure_ascii=True))

def torrents(request):
    raw=request({'action':'list'},'/torrents')
    if not isinstance(raw,list):
        raise RuntimeError('Unexpected TorrServer response')
    keys=['hash','title','name','stat','torrent_size','loaded_size','preloaded_bytes','preload_size',
          'download_speed','upload_speed','active_peers','connected_seeders','timestamp']
    return [{**{k:t.get(k) for k in keys},'files':[
        {k:f.get(k) for k in ['id','path','length']} for f in (t.get('file_stats') or [])[:200]]} for t in raw[:500]]

def torrent_action(request,body):
    if set(body) != {'action','hash'} or body['action'] not in ('drop','rem') or not isinstance(body['hash'],str) or not re.fullmatch(r'[a-fA-F0-9]{40}',body['hash']):
        raise ValueError('Выберите торрент и действие')
    if not any(t['hash']==body['hash'] for t in torrents(request)):
        raise ValueError('Торрент уже отсутствует; обновите список')
    request(body,'/torrents')
    if body['action']=='rem' and any(t['hash']==body['hash'] for t in torrents(request)):
        raise RuntimeError('Removal not confirmed')

def db(root):
    directory=root/'database/workspace'
    directory.mkdir(parents=True,exist_ok=True)
    connection=sqlite3.connect(directory/'access.db',timeout=3)
    connection.execute('CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, ip TEXT, ua TEXT, first REAL, last REAL, requests INTEGER, torrent TEXT, route TEXT)')
    connection.execute('CREATE TABLE IF NOT EXISTS blocks (ip TEXT PRIMARY KEY, created REAL)')
    return connection

def address(value):
    if not isinstance(value,str) or '%' in value:
        raise ValueError('Некорректный IP')
    parsed=ipaddress.ip_address(value)
    return str(parsed.ipv4_mapped if isinstance(parsed,ipaddress.IPv6Address) and parsed.ipv4_mapped else parsed)

def access(root,ip,ua,uri):
    ip=address(ip);ua=ua[:300];now=time.time()
    with closing(db(root)) as conn, conn:
        blocked=conn.execute('SELECT 1 FROM blocks WHERE ip=?',(ip,)).fetchone() is not None
        parsed=urlsplit(uri)
        route=parsed.path
        if route=='/' or route.startswith(('/ts','/lite/','/online','/workspace-client.js')):
            identity=hashlib.sha256((ip+'\0'+ua).encode()).hexdigest()[:24]
            match=re.search(r'/([a-fA-F0-9]{40})(?:/|$)',route)
            candidate=(parse_qs(parsed.query).get('link') or [''])[0]
            torrent=match[1].lower() if match else candidate.lower() if re.fullmatch(r'[a-fA-F0-9]{40}',candidate) else ''
            # Never store tokens, URLs, account names or arbitrary query strings.
            safe_route='TorrServer' if route.startswith('/ts') else 'Источники' if route.startswith('/lite/') else 'Lampa'
            conn.execute('INSERT INTO clients VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET last=excluded.last,requests=requests+1,torrent=CASE WHEN excluded.torrent != \'\' THEN excluded.torrent ELSE clients.torrent END,route=excluded.route',
                         (identity,ip,ua,now,now,torrent,safe_route))
            conn.execute('DELETE FROM clients WHERE last<?',(now-7*86400,))
            conn.execute('DELETE FROM clients WHERE id IN (SELECT id FROM clients ORDER BY last DESC LIMIT -1 OFFSET 2000)')
    return not blocked

def clients(root):
    with closing(db(root)) as conn, conn:
        conn.row_factory=sqlite3.Row
        conn.execute('DELETE FROM clients WHERE last<?',(time.time()-7*86400,))
        rows=[dict(r) for r in conn.execute('SELECT * FROM clients ORDER BY last DESC LIMIT 500')]
        blocks=[r[0] for r in conn.execute('SELECT ip FROM blocks ORDER BY created DESC')]
    return {'clients':rows,'blocked':blocks,'retentionDays':7,'limit':500}

def block(root,body):
    if set(body)!={'ip','blocked'} or type(body['blocked']) is not bool:
        raise ValueError('Некорректная блокировка')
    ip=address(body['ip'])
    if ipaddress.ip_address(ip).is_loopback:
        raise ValueError('Служебный адрес нельзя блокировать')
    with closing(db(root)) as conn, conn:
        if body['blocked']:
            conn.execute('INSERT OR IGNORE INTO blocks VALUES (?,?)',(ip,time.time()))
        else:
            conn.execute('DELETE FROM blocks WHERE ip=?',(ip,))
