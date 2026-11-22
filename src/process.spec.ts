import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { attachAbortKill } from './process';

describe('attachAbortKill', () => {
  it('escalates a SIGTERM-ignoring child to SIGKILL and cleans up cleanly on normal exit', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const controller = new AbortController();
    const handle = attachAbortKill(child, controller.signal, 80);

    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('ready')) resolve();
      });
    });

    controller.abort();

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('close', (code, sig) => {
          handle.cleanup();
          resolve({ code, signal: sig });
        });
      },
    );

    expect(handle.wasAborted()).toBe(true);
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGKILL');

    const fastChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const fastHandle = attachAbortKill(fastChild, new AbortController().signal, 50);
    const fastExit = await new Promise<number | null>((resolve) => {
      fastChild.on('close', (code) => {
        fastHandle.cleanup();
        resolve(code);
      });
    });
    expect(fastExit).toBe(0);
    expect(fastHandle.wasAborted()).toBe(false);
  });
});
