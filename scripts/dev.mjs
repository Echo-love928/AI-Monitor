import { spawn } from 'node:child_process';
const tasks = [['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], ['node_modules/tsx/dist/cli.mjs', 'server/worker.ts'], ['node_modules/vite/bin/vite.js']];
const children = tasks.map(args => spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); process.exitCode = code; }
for (const child of children) child.on('exit', code => stop(code || 0));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
