import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function privateDirectory(root) {
  root = resolve(root); await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';$p=$env:CARDBUSH_BRIDGE_PRIVATE_DIRECTORY;$a=[System.IO.Directory]::GetAccessControl($p);$a.SetAccessRuleProtection($true,$false);$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$r=[System.Security.AccessControl.FileSystemAccessRule]::new($u,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.SetAccessRule($r);[System.IO.Directory]::SetAccessControl($p,$a)`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, env: { ...process.env, CARDBUSH_BRIDGE_PRIVATE_DIRECTORY: root } });
  }
  return root;
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function acquireLock(root) {
  const file = join(root, 'service.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await unlink(file).catch(() => {}); }; }
    catch (e) { if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8')); if (!Number.isSafeInteger(pid) || pid < 1) throw Error('invalid_service_lock');
      try { process.kill(pid, 0); throw Error('service_already_running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; await unlink(file); }
    }
  }
  throw Error('service_lock_failed');
}
