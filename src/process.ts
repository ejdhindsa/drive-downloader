import type { ChildProcess } from 'node:child_process';

export interface AbortKillHandle {
  wasAborted: () => boolean;
  cleanup: () => void;
}

/**
 * Attaches an AbortSignal listener that terminates the child with SIGTERM and
 * escalates to SIGKILL after graceMs if the process has not yet exited.
 */
export function attachAbortKill(
  child: ChildProcess,
  signal: AbortSignal,
  graceMs = 3000,
): AbortKillHandle {
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;

  const clearKillTimer = () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  };

  const onAbort = () => {
    aborted = true;
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return;
    }
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        child.kill('SIGKILL');
      }
    }, graceMs);
    killTimer.unref();
  };

  signal.addEventListener('abort', onAbort, { once: true });

  return {
    wasAborted: () => aborted,
    cleanup: () => {
      signal.removeEventListener('abort', onAbort);
      clearKillTimer();
    },
  };
}
