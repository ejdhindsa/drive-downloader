import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const rootDir = process.cwd();

const initialBuild = spawnSync('npm', ['run', 'build'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const apiEnv = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR || path.join(rootDir, 'data'),
  STAGING_DIR: process.env.STAGING_DIR || path.join(rootDir, 'staging'),
};

const children = [
  spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }),
  spawn(process.execPath, ['--watch', 'dist/src/server.js'], {
    cwd: rootDir,
    env: apiEnv,
    stdio: 'inherit',
  }),
  spawn('npm', ['--prefix', 'web', 'run', 'dev'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }),
];

let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!exiting && code && code !== 0) {
      shutdown(code);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
