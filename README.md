# Support Chat

## Установка на новый сервер (с доменом и HTTPS)

```bash
# 1. Загрузить на сервер
scp support-chat.tar.gz root@IP:/root/

# 2. Распаковать
cd /root && tar -xzf support-chat.tar.gz && cd support-chat

# 3. Запустить установщик
sudo bash setup.sh
```

Скрипт спросит домен, токен и group ID — и сделает всё сам:
- установит Docker и Caddy
- настроит HTTPS (Let's Encrypt, бесплатно)
- запустит приложение
- настроит firewall

После установки сайт будет на `https://ваш-домен` без указания порта.

---

## Обновление (уже установлено)

```bash
cd /root/support-chat
docker compose down && docker compose build --no-cache && docker compose up -d
```

---

## Команды

```bash
docker logs support-chat -f          # логи приложения
docker compose restart               # перезапуск без пересборки
journalctl -u caddy -f               # логи Caddy
systemctl restart caddy              # перезапуск Caddy
```

---

## Telegram

1. @BotFather → /newbot → скопировать токен
2. Создать супергруппу → Настройки → Темы → Включить
3. Добавить бота как администратора (управление группой + темами + публикация)
4. GROUP_ID узнать через @userinfobot (вид: -1001234567890)

Команды в темах:
- `/close` — закрыть тикет
- `/reopen` — переоткрыть тикет

Статусы: 🟢 открыт · 🟡 ждёт ответа · 🔴 закрыт
