import { spawn } from 'node:child_process';
const children = ['index', 'worker'].map(name => spawn(process.execPath, [`dist-server/server/${name}.js`], { stdio: 'inherit', windowsHide: true }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill()); process.exitCode = code; }
children.forEach(child => child.on('exit', code => stop(code || 0)));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
