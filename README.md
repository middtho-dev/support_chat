# Support Chat

Веб-чат поддержки с интеграцией Telegram. Клиенты пишут через браузер, операторы отвечают в Telegram-группе.

## Возможности

- Реальный обмен сообщениями (Socket.IO)
- Загрузка файлов: фото, видео, аудио, документы до 50 МБ
- Telegram: каждое обращение — отдельная тема в группе
- Автозакрытие тикета после 1 часа неактивности
- HTTPS через Let's Encrypt (Caddy)

---

## Быстрый старт

**Требования:** VPS с Ubuntu/Debian, домен с A-записью на IP, порты 80 и 443 открыты.

### 1. Подготовка Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте токен
2. Создайте супергруппу → **Настройки → Темы → Включить**
3. Добавьте бота в группу как **администратора** (управление группой, темами, публикация)
4. Узнайте ID группы через [@userinfobot](https://t.me/userinfobot) — вид: `-1001234567890`

### 2. Установка

```bash
scp -r support_chat root@<IP>:/root/
ssh root@<IP>
cd /root/support_chat
bash setup.sh
```

Скрипт спросит домен, токен и Group ID, затем установит Docker и Caddy, настроит HTTPS и запустит приложение.

---

## Управление

```bash
# Обновление после изменений кода
sudo bash update.sh

# Логи
docker logs support-chat -f

# Перезапуск
docker compose restart

# Остановка
docker compose down
```

---

## Команды Telegram

Внутри темы тикета:

| Команда | Действие |
|---------|----------|
| `/close` | Закрыть тикет |
| `/reopen` | Переоткрыть тикет |

---

## Переменные окружения

Создаются автоматически при `setup.sh`. Редактировать в `.env`, после — `sudo bash update.sh`.

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `TELEGRAM_BOT_TOKEN` | Токен бота | — |
| `TELEGRAM_GROUP_ID` | ID группы (отрицательное) | — |
| `PORT` | Порт приложения | `3001` |
| `DB_PATH` | Путь к SQLite базе | `/app/data/support.db` |
| `UPLOADS_DIR` | Папка загрузок | `/app/public/uploads` |
| `CORS_ORIGIN` | Разрешённый origin для Socket.IO | `*` |

---

## Резервные копии

```bash
# База данных
docker cp support-chat:/app/data/support.db ./backup_$(date +%Y%m%d).db

# Загруженные файлы
docker cp support-chat:/app/public/uploads ./backup_uploads_$(date +%Y%m%d)
```

---

## Структура

```
support_chat/
├── src/
│   ├── server.js      # Express + Socket.IO
│   ├── database.js    # SQLite
│   └── telegram.js    # Telegram Bot
├── public/
│   ├── index.html
│   └── js/app.js
├── Dockerfile
├── docker-compose.yml
├── setup.sh
└── update.sh
```
