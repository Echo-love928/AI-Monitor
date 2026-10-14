import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, defaults } from './config.js';
import type { Settings, Source } from '../shared/types.js';
export class Store {
  db: DatabaseSync;
  constructor(filename = path.join(config.dataDir, 'signal.sqlite')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    const initialize = () => this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects (space TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(space,id));
      CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL,kind TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(day,kind));
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`);
    const until = Date.now() + 5000;
    for (;;) { try { initialize(); break; } catch (error) { if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= until) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
    this.transaction(() => {
      const saved = this.get<Settings>('state', 'settings');
      if (!saved) this.put('state', 'settings', defaults);
      else if (!saved.model && defaults.model || !saved.recipient && defaults.recipient) this.put('state', 'settings', { ...saved, model: saved.model || defaults.model, recipient: saved.recipient || defaults.recipient });
      if (!this.get('state', 'initialized')) {
        const sources: Source[] = [
          { id: 'bing', name: 'Bing 网页搜索', kind: 'web', url: 'https://www.bing.com/search', enabled: true, official: false },
          { id: 'duckduckgo', name: 'DuckDuckGo · 备选', kind: 'web', url: 'https://html.duckduckgo.com/html/', enabled: false, official: false },
          { id: 'twitter', name: 'X / TwitterAPI.io', kind: 'x', url: 'https://api.twitterapi.io', enabled: true, official: false },
          { id: 'openai', name: 'OpenAI News', kind: 'rss', url: 'https://openai.com/news/rss.xml', enabled: true, official: true },
          { id: 'google', name: 'Google AI Blog', kind: 'rss', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', enabled: true, official: true },
        ];
        sources.forEach(source => this.put('sources', source.id, source)); this.put('state', 'initialized', true);
      }
      if (!this.get('state', 'huggingfaceSourceAdded')) {
        this.put('sources', 'huggingface', { id: 'huggingface', name: 'Hugging Face Blog', kind: 'rss', url: 'https://huggingface.co/blog/feed.xml', enabled: true, official: true });
        this.put('state', 'huggingfaceSourceAdded', true);
      }
    });
  }
  get<T>(space: string, id: string): T | null { const row = this.db.prepare('SELECT data FROM objects WHERE space=? AND id=?').get(space, id); return row ? JSON.parse(row.data as string) as T : null; }
  list<T>(space: string): T[] { return this.db.prepare('SELECT data FROM objects WHERE space=? ORDER BY updated DESC').all(space).map(row => JSON.parse(row.data as string) as T); }
  put(space: string, id: string, value: unknown): void { this.db.prepare('INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(space, id, JSON.stringify(value), Date.now()); }
  remove(space: string, id: string): void { this.db.prepare('DELETE FROM objects WHERE space=? AND id=?').run(space, id); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  settings(): Settings { return this.get<Settings>('state', 'settings') || { ...defaults }; }
  day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  usage(): Record<string, number> { return Object.fromEntries(this.db.prepare('SELECT kind,used FROM usage WHERE day=?').all(this.day()).map(row => [row.kind, row.used])); }
  reserve(kind: string, amount: number, limit: number): boolean { return this.transaction(() => { const used = Number(this.db.prepare('SELECT used FROM usage WHERE day=? AND kind=?').get(this.day(), kind)?.used || 0); if (used + amount > limit) return false; this.db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=excluded.used').run(this.day(), kind, used + amount); return true; }); }
  lease(name: string, owner: string, ttl: number): boolean { return this.transaction(() => { const old = this.db.prepare('SELECT * FROM leases WHERE name=?').get(name); if (old && Number(old.expires) > Date.now() && old.owner !== owner) return false; this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(name, owner, Date.now() + ttl); return true; }); }
  release(name: string, owner: string): void { this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, owner); }
  close(): void { this.db.close(); }
}
