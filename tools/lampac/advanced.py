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
HOME_STYLE = {
 'workspace_home_accent': ('Цвет акцента', {'native':'Как в Lampa','cyan':'KV9 · голубой','violet':'Фиолетовый','amber':'Янтарный','mint':'Мятный'}),
 'workspace_home_surface': ('Подложка верхней панели и меню', {'native':'Как в Lampa','glass':'Полупрозрачная','solid':'Тёмная'}),
 'workspace_home_corners': ('Скругление панелей', {'native':'Как в Lampa','soft':'Мягкое','square':'Прямое'}),
 'workspace_home_motion': ('Движение интерфейса', {'native':'Как в Lampa','reduced':'Минимум анимации'})}
CLIENT.update(HOME_STYLE)
CLIENT['workspace_kv9_theme']=('Фирменная тема KV9',None)
# Native component names come from Lampa Settings; unknown plugin sections use "other".
SETTINGS_SECTIONS = {'all':'Все настройки', 'account':'Аккаунт CUB', 'interface':'Интерфейс',
 'player':'Плеер', 'parser':'Поиск торрентов', 'server':'TorrServer', 'tmdb':'TMDB',
 'plugins':'Плагины', 'parental_control':'Родительский контроль', 'more':'Дополнительно',
 'workspace_device':'Workspace · информация', 'other':'Разделы других плагинов'}
CLIENT.update({'workspace_settings_'+k:(v,None) for k,v in SETTINGS_SECTIONS.items()})
CLIENT['workspace_kv9_ambient']=('Анимированный фон KV9',None)
def discovered_key(kind, identity):
    a,b=2166136261,2246822519
    for char in identity:
        a=((a^ord(char))*16777619)&0xffffffff
        b=((b^ord(char))*3266489917)&0xffffffff
    return f'workspace_ui_{kind}_{a:08x}{b:08x}'

CONTROL_ALIASES = {
    **{discovered_key('m',k.removeprefix('workspace_menu_')):k for k in CLIENT if k.startswith('workspace_menu_')},
    **{discovered_key('s',k):'workspace_settings_'+k for k in SETTINGS_SECTIONS if k not in ('all','other')},
}

def normalize_preferences(values):
    # Old discovered duplicates took priority over the original bulk control.
    result={k:v for k,v in values.items() if k not in CONTROL_ALIASES}
    for key,value in values.items():
        if key in CONTROL_ALIASES:result[CONTROL_ALIASES[key]]=value
    return result

PREFERENCE_HELP = {
 'source':('Каталог','Источник названий, постеров и описаний фильмов: TMDB или CUB. Не выбирает источник воспроизведения.'),
 'start_page':('Каталог','Раздел, открываемый при запуске Lampa. «Последняя» возвращает к предыдущему разделу.'),
 'adult_content_view':('Каталог','Разрешает показывать взрослый контент в поддерживающих этот параметр каталогах. Не включает серверный модуль 18+.'),
 'screensaver':('Заставка','Показывает заставку при бездействии; не заменяет анимированный фон KV9.'),
 'screensaver_type':('Заставка','Источник изображений или видео заставки. Работает только при включённой заставке.'),
 'screensaver_time':('Заставка','Количество минут бездействия до запуска заставки.'),
 'background':('Штатное оформление Lampa','Показывает фон, который выбирает сама Lampa. В каталоге при активном фоне KV9 он временно скрыт; внутри фильма сохраняется.'),
 'background_type':('Штатное оформление Lampa','Вид штатного фона Lampa. Применяется при включённом фоне; не меняет фон KV9.'),
 'black_style':('Штатное оформление Lampa','Чёрная схема штатного интерфейса. Тема KV9 имеет приоритет; это значение сохраняется при её выключении.'),
 'glass_style':('Штатное оформление Lampa','Прозрачные подложки штатного интерфейса. Тема KV9 задаёт собственные цвета панелей.'),
 'light_version':('Производительность','Упрощённый интерфейс Lampa для слабых устройств. Может менять расположение и доступность декоративных элементов.'),
 'animation':('Движение и звук','Анимации переходов самой Lampa. Анимированный фон KV9 управляется отдельно.'),
 'advanced_animation':('Движение и звук','Дополнительные эффекты Lampa. Могут увеличить нагрузку на слабых телевизорах.'),
 'interface_sound_play':('Движение и звук','Звуковые сигналы при перемещении по интерфейсу; не меняет громкость фильма.'),
 'helper':('Интерфейс','Подсказки по управлению с пульта и клавиатуры в поддерживаемых экранах.'),
 'mask':('Интерфейс','Затемнение краёв прокручиваемых списков средствами Lampa.'),
 'interface_size':('Интерфейс','Размер элементов интерфейса: компактный для ПК, крупный для просмотра издалека. Требует перезапуска Lampa.'),
 'poster_size':('Производительность','Разрешение постеров из каталога. Более высокое качество увеличивает трафик и расход памяти.'),
 'hide_outside_the_screen':('Производительность','Скрывает элементы списков за пределами экрана, уменьшая нагрузку на отрисовку.'),
 'cache_images':('Производительность','Сохраняет изображения в кеше устройства для повторного использования. Не меняет кеш сервера TMDB.'),
 'card_quality':('Карточки каталога','Показывает бейдж качества видео, если источник передаёт эти сведения.'),
 'card_episodes':('Карточки каталога','Показывает сведения об эпизодах на карточках сериалов, когда они доступны.'),
 'card_interfice_poster':('Страница фильма','Показывает постер на открытой странице фильма или сериала.'),
 'card_interfice_cover':('Страница фильма','Показывает обложку на открытой странице фильма или сериала.'),
 'card_interfice_reactions':('Страница фильма','Показывает реакции на странице фильма, если их поддерживает каталог.'),
 'menu_always':('Интерфейс','Держит левое меню раскрытым на поддерживаемых устройствах. Видимость его пунктов настраивается отдельно.'),
 'playlist_next':('Плеер','Автоматически запускает следующий элемент плейлиста после завершения текущего.'),
 'player_normalization':('Плеер','Выравнивание громкости средствами встроенного плеера. Поддержка зависит от платформы.'),
 'player_external_fullscreen':('Плеер','Запрашивает полноэкранный запуск внешнего плеера. Внешнее приложение может использовать свои настройки.'),
 'subtitles_start':('Субтитры','Включает доступные субтитры при запуске видео во встроенном плеере.'),
 'subtitles_stroke':('Субтитры','Обводка букв для лучшей читаемости субтитров на светлом видео.'),
 'subtitles_backdrop':('Субтитры','Подложка за субтитрами. Работает в плеерах, поддерживающих оформление субтитров Lampa.'),
 'internal_torrclient':('Торренты · клиент','Использует торрент-движок приложения Android / Android TV. На других платформах нужен TorrServer; переключатель не устанавливает движок.'),
 'torrserver_gts':('Торренты · клиент','Использует глобальный адрес TorrServer вместо адреса, заданного на устройстве.'),
 'torrserver_savedb':('Торренты · клиент','Просит TorrServer сохранять добавленные торренты в его базе для повторного открытия.'),
 'torrserver_preload':('Торренты · клиент','Включает предварительный набор буфера перед просмотром. Размер буфера задаётся отдельно в серверных настройках TorrServer.'),
 'torrserver_tracktimecode':('Торренты · клиент','Сохранение позиции просмотра через TorrServer для продолжения воспроизведения.'),
 'parser_use':('Поиск торрентов','Разрешает клиенту использовать настроенный парсер торрентов. Адрес и доступность парсера задаются отдельно.'),
 'parse_in_search':('Поиск торрентов','Добавляет результаты торрентов в общий поиск Lampa при доступном парсере.'),
 'cloud_use':('Поиск торрентов','Использует облачные торренты, если эту возможность поддерживает установленный клиент.'),
 'proxy_tmdb':('Сеть клиента','Отправляет запросы к TMDB через прокси клиента Lampa. Не меняет прокси сервера Lampac.'),
 'proxy_tmdb_auto':('Сеть клиента','Автоматический выбор прокси TMDB средствами Lampa. При включении ручной выбор может не использоваться.'),
 'proxy_other':('Сеть клиента','Проксирование других поддерживаемых запросов клиентом Lampa. Не включает VPN на устройстве или сервере.'),
}

def preference_meta(key):
    if key=='workspace_kv9_theme':
        return {'group':'Тема KV9','description':'Фирменные цвета, скругления и контрастное выделение. Выключение возвращает штатное оформление Lampa.','global':True}
    if key=='workspace_kv9_ambient':
        return {'group':'Тема KV9','description':'Медленно движущийся бирюзовый фон каталога и меню. Внутри фильма и во время воспроизведения скрывается. Работает с темой KV9; при системном уменьшении движения остаётся статичным.','global':True,'default':'true'}
    if key.startswith('workspace_header_'):
        return {'group':'Видимость · Верхняя панель','description':'Показывать «'+HEADER[key.removeprefix('workspace_header_')]+'» в верхней панели. Не удаляет данные и не включает отсутствующие функции.','global':True,'visibility':True}
    if key.startswith('workspace_settings_'):
        name=key.removeprefix('workspace_settings_')
        text='Доступ к разделу «'+SETTINGS_SECTIONS[name]+'» на устройстве. Отдельно разрешённые пункты остаются доступны внутри скрытого раздела.'
        if name=='all':text='Базовая доступность всех разделов настроек. Явно разрешённый раздел или отдельный пункт имеет приоритет.'
        if name=='other':text='Базовая доступность неизвестных разделов плагинов. Явные переключатели раздела и его пунктов имеют приоритет.'
        return {'group':'Видимость · Разделы настроек','description':text,'global':True,'visibility':True}
    if key.startswith('workspace_menu_'):
        return {'group':'Видимость · Левое меню','description':'Показывает этот пункт в боковом меню. Не отключает каталог или источник воспроизведения.','global':True,'visibility':True}
    group,description=PREFERENCE_HELP.get(key,('Совместимость','Устаревшая настройка; сохранена только для совместимости существующих профилей.'))
    return {'group':group,'description':description,'global':True}
PROVIDER = {
    'enable': ('Включён', 'bool'), 'displayname': ('Название в списке', 'text'),
    'displayindex': ('Порядок в списке', 'int', -1000, 10000),
    'host': ('Адрес источника', 'url'), 'httptimeout': ('Таймаут HTTP, секунд', 'int', 1, 120),
    'cache_time': ('Кеш источника, минут', 'int', 0, 1000000),
    'useproxy': ('Прокси для запросов', 'bool'), 'streamproxy': ('Видео через сервер Lampac', 'bool'),
    'useproxystream': ('Видео через внешний прокси', 'bool'), 'hls': ('Использовать HLS', 'bool'),
    'token': ('Токен · пустое поле сохраняет текущий', 'secret'),
    'login': ('Логин · пустое поле сохраняет текущий', 'secret'),
    'passwd': ('Пароль · пустое поле сохраняет текущий', 'secret'),
}

PROVIDER_HELP = {
 'enable':'Доступность этого источника онлайн-видео. Отключение убирает его из выдачи, сохраняя остальные параметры.',
 'displayname':'Название этого источника в списке выбора видео.',
 'displayindex':'Порядок источника в выдаче Lampac. Меньшие значения располагаются раньше; одинаковые значения допускаются.',
 'host':'Основной адрес источника. Меняйте при смене его домена; токен или авторизация могут быть привязаны к адресу.',
 'httptimeout':'Сколько секунд Lampac ждёт HTTP-ответ именно этого источника. Это не лимит длительности видео.',
 'cache_time':'Желаемый срок кеширования ответа источника в минутах. 0 использует штатный срок модуля; модуль может ограничивать максимальное время.',
 'useproxy':'Запросы к каталогу/API этого источника через уже настроенный внешний прокси. Сам по себе не включает передачу видео через прокси.',
 'streamproxy':'Видео проходит через сервер Lampac вместо прямого подключения устройства к источнику. Увеличивает трафик сервера.',
 'useproxystream':'Lampac получает видео через настроенный внешний прокси и передаёт устройству. Также включает серверную передачу видео; отличается от прямой передачи через Lampac.',
 'hls':'Предпочитать поток HLS, если модуль источника поддерживает такой выбор. Не преобразует произвольный файл в HLS.',
 'token':'Токен доступа к этому источнику. Текущее значение не показывается; пустое поле сохраняет его.',
 'login':'Логин учётной записи источника. Пустое поле сохраняет текущие данные.',
 'passwd':'Пароль учётной записи источника. Пустое поле сохраняет текущие данные.',
}
PLUGIN_HELP = {
 'online':'Добавляет клиентский плагин выбора онлайн-видео. Сами источники настраиваются в отдельных группах ниже.',
 'torrserver':'Добавляет интеграцию TorrServer в Lampa. Серверный модуль включается отдельно на вкладке «Сервер».',
 'jacred':'Добавляет клиентский поиск торрентов JacRed; нужен доступный сервер парсера.',
 'catalog':'Подключает дополнительные каталоги в клиенте Lampa.',
 'dorama':'Подключает клиентский раздел дорам.',
 'sisi':'Подключает клиентский раздел 18+. Параметры каталога устройства настраиваются отдельно.',
 'dlna':'Добавляет клиентскую интеграцию DLNA. Серверный модуль DLNA и доступ в его локальную сеть нужны отдельно.',
 'tracks':'Подключает возможности работы с аудиодорожками, предоставляемые установленным модулем.',
 'transcoding':'Подключает клиентскую интеграцию транскодирования; не устанавливает кодеки и серверный движок.',
 'tmdbProxy':'Подключает прокси TMDB к клиенту. Сроки серверного кеша заданы в группе «Сервер и каталог».',
 'cubProxy':'Подключает прокси CUB к клиенту; не включает авторизацию аккаунта CUB.',
 'sync':'Подключает клиентскую синхронизацию. Серверный модуль синхронизации включается отдельно.',
 'bookmark':'Добавляет клиентский плагин закладок.',
 'timecode':'Подключает клиентское сохранение позиции просмотра. Серверный модуль позиции просмотра включается отдельно.',
 'backup':'Подключает резервное копирование данных клиента. Не управляет резервными копиями Workspace.',
 'watch_together':'Подключает возможности совместного просмотра в клиенте.',
 'pirate_store':'Добавляет клиентский магазин плагинов; отдельные плагины устанавливаются через него.',
}
SERVER_HELP = {
 'autoupdate':'Разрешает серверу обновлять раздаваемую веб-версию Lampa. Не обновляет приложение на телевизоре.',
 'intervalupdate':'Период проверки обновлений веб-версии в минутах. Используется при включённом автообновлении.',
 'showquality':'Передаёт отметки качества от онлайн-источников. Показ бейджа на карточках отдельно регулируется профилем Lampa.',
 'checkOnlineSearch':'Проверяет доступность результатов онлайн-поиска средствами установленных модулей. Может увеличить время ожидания результатов.',
 'btn_priority_forced':'Принудительно задаёт приоритет кнопки онлайн-просмотра в клиентской интеграции Lampac.',
 'spider':'Объединённый поиск Spider средствами установленной версии онлайн-модуля.',
 'version':'Показывает версию клиентского онлайн-плагина. Не обновляет плагин.',
 'cache_api':'Срок серверного кеша ответов TMDB в минутах. 0 отключает этот кеш; не очищает кеш клиента Lampa.',
 'cache_img':'Срок серверного кеша изображений TMDB в минутах. 0 отключает этот кеш; не меняет качество постеров клиента.',
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
                        description=(PLUGIN_HELP[key] if section=='LampaWeb.initPlugins' else SERVER_HELP[key] if group=='Сервер и каталог' else PROVIDER_HELP[key]),
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

def dynamic_key(key):
    return isinstance(key,str) and re.fullmatch(r'workspace_ui_[ism]_[a-f0-9]{16}',key) is not None

def valid_preference(key,value):
    return isinstance(value,str) and (value in {'true','false'} if dynamic_key(key) else key in CLIENT and value in (CLIENT[key][1] or {'true':1,'false':1}))

def client_settings(config, controls=None):
    current=config.get('WorkspaceUI',{})
    fields=[{'key':k,'label':v[0],'options':v[1] or {'true':'Включено','false':'Выключено'}, **preference_meta(k)} for k,v in CLIENT.items() if k not in HOME_STYLE]+[{'key':c['key'],'label':c['label'],'group':{'Пункты левого меню':'Видимость · Левое меню','Разделы настроек':'Видимость · Разделы настроек'}.get(c['group'],c['group'].replace('Пункты: ','Видимость · ')),'options':{'true':'Доступен','false':'Скрыт'},'description':((c.get('description','')+' ') if c.get('description') else '')+('Показывает отдельный пункт меню; сам плагин продолжает работать.' if c['key'].startswith('workspace_ui_m_') else 'Доступность пункта в Lampa, а не его значение. Явное включение разрешает его даже внутри скрытого раздела.'),'global':True,'visibility':True} for c in (controls or []) if c['key'] not in CONTROL_ALIASES]
    groups=['Тема KV9','Интерфейс','Каталог','Карточки каталога','Страница фильма','Движение и звук','Штатное оформление Lampa','Производительность','Заставка','Плеер','Субтитры','Поиск торрентов','Торренты · клиент','Сеть клиента','Видимость · Верхняя панель','Видимость · Левое меню','Видимость · Разделы настроек']
    fields.sort(key=lambda f:(groups.index(f['group']) if f['group'] in groups else len(groups),f['group']))
    return {'mode':current.get('mode','disabled'),'values':normalize_preferences(current.get('values',{})),'fields':fields}

def apply_client(config, effective, body, public_url):
    if set(body) != {'mode','values'} or body['mode'] not in ('disabled','revision','always') or not isinstance(body['values'],dict):
        raise ValueError('Некорректная политика клиента')
    for key,value in body['values'].items():
        if not valid_preference(key,value):
            raise ValueError('Недопустимое значение клиента')
    result=copy.deepcopy(config)
    result['WorkspaceUI']={**body,'values':normalize_preferences(body['values']),'revision':str(time.time_ns())}
    url=public_url.rstrip('/')+'/workspace-client.js'
    plugins=copy.deepcopy(effective.get('LampaWeb',{}).get('customPlugins') or [])
    plugins=[p for p in plugins if p.get('author')!='workspace-panel']
    # Keep the plugin enabled when policy is disabled, so it can release managed keys.
    plugins.append({'url':url,'name':'Workspace preferences','author':'workspace-panel','status':1})
    result.setdefault('LampaWeb',{})['customPlugins']=plugins
    return result

def client_script(config):
    policy=config.get('WorkspaceUI',{'mode':'disabled','values':{},'revision':'0'})
    policy={**policy,'values':normalize_preferences(policy.get('values',{}))}
    # JSON is data, never interpolated into an executable string literal.
    return (Path(__file__).parent/'ambient.js').read_text(encoding='utf-8') + '\n' + (Path(__file__).parent/'ui-controls.js').read_text(encoding='utf-8') + '\n' + (Path(__file__).parent/'client-profile.js').read_text(encoding='utf-8').replace('POLICY',json.dumps(policy,ensure_ascii=True))

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
