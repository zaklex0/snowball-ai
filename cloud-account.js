'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { exportBytes } = require('./safe-export');
const { CloudSync } = require('./cloud-sync');
const { CloudLocal } = require('./cloud-local');
const config = require('./cloud-config');
function message(error) {
  const code = error?.code;
  if (['invalid_credentials', 'invalid_grant'].includes(code)) return 'Почта или пароль не подходят.';
  if (code === 'email_not_confirmed') return 'Подтвердите почту по ссылке из письма, затем войдите.';
  if (code === 'over_email_send_rate_limit' || error?.status === 429) return 'Слишком много попыток. Подождите немного.';
  if (['PGRST202', '42P01', 'PGRST205'].includes(code)) return 'Облачный проект ещё не настроен. Выполните cloud-schema.sql в Supabase.';
  if (code === 'weak_password') return 'Выберите более длинный пароль: не менее 8 символов.';
  if (error?.status === 401) return 'Войдите в аккаунт снова.';
  if (error?.name === 'AbortError' || /fetch|network|timeout/i.test(error?.message || '')) return 'Нет связи с облаком. Данные остаются на компьютере; повторим позже.';
  // SDK/network errors may contain session data: never return or log their raw text.
  return 'Не удалось обратиться к облаку. Проверьте подключение и настройки проекта.';
}
class CloudAccount {
  constructor({ userData, safeStorage, getStore, lock, changed, emit, backup }) {
    Object.assign(this, { userData, safeStorage, getStore, lock, changed, emit, backup });
    this.status = { email: '', busy: false, lastSync: 0, error: '', conflicts: [] };
    this.queue = Promise.resolve(); this.engine = null; this.authBlocked = false;
    const sessionFile = path.join(userData, 'cloud-session.bin');
    const storageKey = 'snowball-cloud-auth';
    const storage = {
      getItem: async key => {
        if (key !== storageKey) return null;
        try { return safeStorage.decryptString(await fsp.readFile(sessionFile)); }
        catch (e) { if (e.code !== 'ENOENT') { this.authBlocked = true; this.status.error = 'Не удалось прочитать сохранённый вход. Выйдите из аккаунта и войдите снова.'; } return null; }
      },
      setItem: async (_key, value) => {
        if (_key !== storageKey) return;
        if (this.authBlocked || !safeStorage.isEncryptionAvailable()) throw Error('Сохранение входа недоступно.');
        await exportBytes(sessionFile, safeStorage.encryptString(value));
      },
      removeItem: async key => { if (key !== storageKey) return; await fsp.rm(sessionFile, { force: true }); this.authBlocked = false; }
    };
    this.client = createClient(config.url, config.key, {
      auth: { storage, storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(25000) }) }
    });
    this.client.auth.onAuthStateChange((_event, session) => {
      this.session = session; this.status.email = session?.user?.email || ''; this.publish();
    });
  }
  publish() {
    this.status.conflicts = Object.entries(this.engine?.state.conflicts || {}).map(([key, c]) => ({
      key, name: c.local?.value?.title || c.local?.value?.name || c.remote?.value?.title || c.remote?.value?.name || key,
      local: c.local, remote: c.remote
    }));
    this.emit({ ...this.status });
  }
  run(fn) { const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next; }
  async start() {
    try { await this.client.auth.getSession(); } catch (e) { this.status.error = message(e); }
    this.timer = setInterval(() => this.sync(), 20000); this.timer.unref();
    this.sync();
  }
  async auth(command, email, password) {
    return this.run(async () => {
      if (!['signin', 'signup', 'signout'].includes(command)) return { ok: false, error: 'Неизвестная команда.' };
      if (command === 'signout') {
        await this.client.auth.signOut({ scope: 'local' }); this.engine = null; this.session = null;
        this.status = { email: '', busy: false, lastSync: 0, error: '', conflicts: [] }; this.publish(); return { ok: true };
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 1024) return { ok: false, error: 'Введите почту и пароль длиной не менее 8 символов.' };
      if (this.authBlocked) return { ok: false, error: this.status.error };
      try {
        const { data, error } = await this.client.auth[command === 'signup' ? 'signUp' : 'signInWithPassword']({ email: email.trim(), password });
        if (error) return { ok: false, error: message(error) };
        this.session = data.session;
        this.status.email = data.session?.user.email || ''; this.status.error = ''; this.publish();
        if (data.session) setTimeout(() => this.sync(), 0);
        return { ok: true, message: data.session ? 'Вход выполнен. Начинаю синхронизацию.' : 'Проверьте почту, подтвердите адрес и нажмите «Войти».' };
      } catch (e) { return { ok: false, error: message(e) }; }
    });
  }
  async prepare() {
    const store = this.getStore(), uid = this.session.user.id;
    if (this.engine && this.engine.local.store === store && this.uid === uid) return;
    const dir = path.join(store.dir, '.cloud-sync'); await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    let state;
    try { state = JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw Object.assign(Error(), { userMessage: 'Повреждено состояние синхронизации. Файл сохранён; автоматическое объединение остановлено.' }); state = { uid, project: config.url, base: {}, conflicts: {}, manifests: {} }; }
    if (state.uid !== uid || state.project !== config.url) throw Object.assign(Error(), { userMessage: 'Эта папка связана с другим аккаунтом. Для нового аккаунта выберите отдельную пустую папку данных.' });
    const save = s => exportBytes(file, JSON.stringify(s));
    if (!state.backup) { state.backup = await this.backup(store); await save(state); }
    this.uid = uid;
    const uploaded = new Set();
    const remote = {
      list: async (base = {}) => {
        const records = {}; let cursor = '';
        while (true) {
          let query = this.client.from('snowball_records').select('key,version').order('key').limit(500);
          if (cursor) query = query.gt('key', cursor);
          const { data, error } = await query;
          if (error) throw error;
          for (const row of data) records[row.key] = row;
          if (data.length < 500) break;
          cursor = data[data.length - 1].key;
        }
        const changed = Object.keys(records).filter(key => !base[key] || base[key].version !== records[key].version);
        for (let i = 0; i < changed.length; i += 20) {
          const { data, error } = await this.client.from('snowball_records').select('key,version,payload').in('key', changed.slice(i, i + 20));
          if (error) throw error;
          for (const row of data) records[row.key] = row;
        }
        return records;
      },
      put: async (key, expected, payload) => {
        if (this.getStore() !== store) throw Object.assign(Error(), { userMessage: 'Папка данных сменилась. Повторим синхронизацию.' });
        const { data, error } = await this.client.rpc('snowball_put', { p_key: key, p_expected: expected, p_payload: payload });
        if (error) throw error; return data;
      },
      upload: async (hash, bytes) => {
        if (uploaded.has(hash)) return;
        const { error } = await this.client.storage.from('snowball-files').upload(uid + '/' + hash, bytes, { contentType: 'application/octet-stream', upsert: false });
        if (error && error.status !== 409 && String(error.statusCode) !== '409' && !['Duplicate', 'ResourceAlreadyExists'].includes(error.code)) throw error;
        uploaded.add(hash);
      },
      download: async hash => {
        const { data, error } = await this.client.storage.from('snowball-files').download(uid + '/' + hash);
        if (error) throw error; return Buffer.from(await data.arrayBuffer());
      }
    };
    const local = new CloudLocal(store, { remote, lock: (fn, key) => this.lock(store, fn, key), changed: this.changed });
    state.manifests ||= {}; local.manifests = state.manifests;
    this.engine = new CloudSync({ remote, local, state, save });
  }
  sync(resolve) {
    // Timer ticks never accumulate while a previous pass is still running.
    if (this.scheduled && !resolve) return this.scheduled;
    const job = this.run(async () => {
      if (!this.session) return { ok: true };
      this.status.busy = true; this.status.error = ''; this.publish();
      try {
        if (this.getStore().dataWarnings.length) throw Object.assign(Error(), { userMessage: 'В папке данных найдены повреждённые или восстановленные записи. Проверьте предупреждения программы перед синхронизацией.' });
        await this.prepare();
        if (resolve) await this.engine.resolve(resolve.key, resolve.choice);
        await this.engine.sync(); this.status.lastSync = Date.now();
        return { ok: true };
      } catch (e) {
        this.status.error = e.userMessage || message(e);
        return { ok: false, error: this.status.error };
      } finally { this.status.busy = false; this.publish(); }
    });
    if (!resolve) { this.scheduled = job; job.finally(() => { if (this.scheduled === job) this.scheduled = null; }); }
    return job;
  }
}
module.exports = { CloudAccount, message };
