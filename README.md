# Support Chat

Чат поддержки с интеграцией Telegram. Клиенты пишут через веб-интерфейс, операторы отвечают в Telegram-группе.

## Возможности

- Реальный обмен сообщениями (Socket.IO)
- Загрузка файлов: фото, видео, аудио, документы до 50 МБ
- Автоматические приветственные сообщения при старте чата
- Telegram: каждое обращение — отдельная тема в группе
- Статусы тикетов: 🟢 открыт · 🟡 ожидает ответа · 🔴 закрыт
- HTTPS через Let's Encrypt (Caddy, бесплатно)
- Сессии сохраняются в браузере

---

## Установка с нуля

### 1. Подготовка Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте токен
2. Создайте супергруппу → **Настройки → Темы → Включить**
3. Добавьте бота в группу как **администратора** (права: управление группой, темами, публикация)
4. Узнайте ID группы через [@userinfobot](https://t.me/userinfobot) — вид: `-1001234567890`

### 2. Развёртывание на сервере

Требования: VPS с Ubuntu/Debian, домен с A-записью на IP сервера, открытые порты 80 и 443.

```bash
# Скопируйте папку на сервер
scp -r support_chat root@<IP>:/root/

# Подключитесь и запустите установщик
ssh root@<IP>
cd /root/support_chat
bash setup.sh
```

Установщик интерактивно спросит домен, токен и Group ID, после чего:
- установит Docker и Caddy
- создаст `.env` с настройками
- настроит HTTPS (Let's Encrypt)
- запустит приложение в Docker
- настроит firewall (порты 22, 80, 443)

После завершения сайт доступен на `https://ваш-домен`.

---

## Обновление

```bash
cd /root/support_chat
sudo bash update.sh
```

Скрипт пересоберёт Docker-образ и перезапустит контейнер. Данные (база, файлы) и настройки Caddy не затрагиваются.

**Вручную (то же самое):**

```bash
cd /root/support_chat
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## Управление

```bash
# Логи приложения в реальном времени
docker logs support-chat -f

# Перезапуск без пересборки образа
docker compose restart

# Полная остановка
docker compose down

# Логи Caddy (HTTPS, SSL)
journalctl -u caddy -f

# Перезапуск Caddy
systemctl restart caddy
```

---

## Команды в Telegram

Внутри темы тикета:

| Команда | Действие |
|---------|----------|
| `/close` | Закрыть тикет |
| `/reopen` | Переоткрыть тикет |

---

## Переменные окружения

Файл `.env` создаётся автоматически при `setup.sh`. При необходимости можно редактировать вручную и после этого выполнить `sudo bash update.sh`.

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather | — |
| `TELEGRAM_GROUP_ID` | ID Telegram-группы (отрицательное число) | — |
| `PORT` | Порт приложения | `3001` |
| `DB_PATH` | Путь к SQLite базе данных | `/app/data/support.db` |
| `UPLOADS_DIR` | Папка для загружаемых файлов | `/app/public/uploads` |
| `CORS_ORIGIN` | Разрешённый origin для Socket.IO | `*` |

---

## Резервные копии

Данные хранятся в Docker volumes (`support-data`, `support-uploads`).

```bash
# База данных
docker cp support-chat:/app/data/support.db ./backup_$(date +%Y%m%d).db

# Загруженные файлы
docker cp support-chat:/app/public/uploads ./backup_uploads_$(date +%Y%m%d)
```

---

## Структура проекта

```
support_chat/
├── src/
│   ├── server.js        # Express + Socket.IO сервер
│   ├── database.js      # SQLite схема и подготовленные запросы
│   └── telegram.js      # Telegram Bot интеграция
├── public/
│   ├── index.html       # HTML-шаблон с инлайн-CSS
│   ├── js/app.js        # Клиентский JavaScript
│   └── logo.png         # Логотип
├── Dockerfile
├── docker-compose.yml
├── setup.sh             # Установка с нуля
├── update.sh            # Быстрое обновление
└── .env                 # Конфигурация (создаётся setup.sh)
```
