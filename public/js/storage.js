(function (root) {
  'use strict';
  function createStorage(access) {
    const memory = new Map();
    return {
      getItem(key) { if (memory.has(key)) return memory.get(key); try { const value = access().getItem(key); if (value !== null) return value; } catch {} return memory.get(key) ?? null; },
      setItem(key, value) { memory.set(key, String(value)); try { access().setItem(key, String(value)); } catch {} },
      removeItem(key) { memory.set(key, null); try { access().removeItem(key); } catch {} }
    };
  }
  if (typeof module !== 'undefined') module.exports = { createStorage };
  else root.SafeStorage = { local: createStorage(() => root.localStorage), session: createStorage(() => root.sessionStorage) };
})(typeof window === 'undefined' ? {} : window);
