import { spawn } from 'node:child_process';

const args = ['--import', 'tsx', 'server/index.mjs'];
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
