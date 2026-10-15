import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './db.js';
import { PublicHttp } from './http.js';
const store = new Store(); const http = new PublicHttp();
const server = createApp(store, http).listen(config.port, '127.0.0.1', () => console.log(`FirstCue API: http://127.0.0.1:${config.port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(async () => { store.close(); await http.close(); process.exit(0); }));
