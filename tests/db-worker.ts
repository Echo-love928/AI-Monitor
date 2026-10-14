import { Store } from '../server/db.js';
const store = new Store(process.argv[2]); store.put('checks', String(process.pid), { ok: true }); store.close();
