const os = require('os');
const crypto = require('crypto');

function backgroundTimer(timer) {
  timer.unref?.();
  return timer;
}

function createTelegramPollingLease({
  database,
  name = 'telegram-get-updates',
  leaseSeconds = 20,
  retryMs = 5000,
  onAcquired,
  onLost,
  logPrefix = '[TG]'
}) {
  const ownerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  const leaseModifier = `+${Math.max(10, Number(leaseSeconds) || 20)} seconds`;
  let timer = null;
  let active = false;
  let running = false;
  let stopped = false;
  let pausedUntil = 0;

  function schedule(delay = retryMs) {
    if (stopped) return;
    clearTimeout(timer);
    timer = backgroundTimer(setTimeout(tick, Math.max(0, delay)));
  }

  async function loseLease(reason) {
    if (!active) return;
    active = false;
    try {
      await onLost?.(reason);
    } catch (error) {
      console.error(`${logPrefix} polling lease cleanup:`, error?.message || error);
    }
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      if (Date.now() < pausedUntil) return;
      if (active) {
        const renewed = database.renewTelegramRuntimeLease.run(
          leaseModifier,
          name,
          ownerId
        ).changes > 0;
        if (!renewed) {
          console.warn(`${logPrefix} polling leadership was transferred`);
          await loseLease('lease-lost');
        }
        return;
      }

      const acquired = database.acquireTelegramRuntimeLease.run(
        name,
        ownerId,
        leaseModifier
      ).changes > 0;
      if (!acquired) return;

      active = true;
      try {
        await onAcquired?.();
        console.log(`${logPrefix} polling leadership acquired`);
      } catch (error) {
        database.releaseTelegramRuntimeLease.run(name, ownerId);
        active = false;
        console.error(`${logPrefix} polling startup:`, error?.message || error);
      }
    } catch (error) {
      console.error(`${logPrefix} polling lease:`, error?.message || error);
      await loseLease('lease-error');
    } finally {
      running = false;
      schedule();
    }
  }

  async function pause(durationMs, reason = 'paused') {
    pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(1000, Number(durationMs) || retryMs));
    try {
      database.releaseTelegramRuntimeLease.run(name, ownerId);
    } catch {}
    await loseLease(reason);
    schedule(Math.max(1000, pausedUntil - Date.now()));
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    try {
      database.releaseTelegramRuntimeLease.run(name, ownerId);
    } catch {}
    await loseLease('shutdown');
  }

  return {
    start: () => {
      if (!stopped && !running) void tick();
    },
    isOwner: () => active,
    pause,
    stop,
    status: () => ({
      owner: active,
      ownerId,
      pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null
    })
  };
}

module.exports = { createTelegramPollingLease };
