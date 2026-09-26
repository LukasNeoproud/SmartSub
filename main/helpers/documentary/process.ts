import { spawn } from 'child_process';

export interface DocumentaryTools { ffmpeg: string; ffprobe: string }

export function abortError(): Error {
  const error = new Error('Documentary operation cancelled');
  error.name = 'AbortError';
  return error;
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** No shell. Bounded capture, deadline and cancellation for every child process. */
export function runProcess(
  executable: string, args: string[], signal?: AbortSignal, timeoutMs = 3600000,
): Promise<string> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined;
    const terminate = (error: Error) => { failure = error; child.kill('SIGKILL'); };
    const onAbort = () => terminate(abortError());
    const timer = setTimeout(() => terminate(new Error(`${executable} timed out`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) terminate(new Error('Process output exceeded 16 MiB'));
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(error.code === 'ENOENT'
        ? new Error(`${executable} was not found. Install FFmpeg with ffprobe; on macOS: brew install ffmpeg. You can set SMARTSUB_FFPROBE_PATH.`)
        : error);
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${executable} exited with code ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}
