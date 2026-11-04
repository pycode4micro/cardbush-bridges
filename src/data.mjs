import { readdir, cp, rename, rm, rmdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { privateDirectory, readJson, acquireLock } from './shared/storage.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entries = directory => readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
export async function prepareData(bridge, { env = process.env, dataRoot = resolve(env.CARDBUSH_BRIDGES_DATA || join(projectRoot, '.private')),
  legacyRoot = dirname(projectRoot.replace(/[\\/]$/, '')), migrate = !env.CARDBUSH_BRIDGES_DATA && !env[bridge.dataEnv], log = console.log } = {}) {
  if (env[bridge.dataEnv]) return privateDirectory(resolve(env[bridge.dataEnv]));
  dataRoot = resolve(dataRoot);
  if (!/^[a-z][a-z0-9-]*$/.test(bridge.id)) throw Error('invalid_bridge_id');
  const target = join(dataRoot, bridge.id), source = bridge.legacyDirectory && join(legacyRoot, bridge.legacyDirectory, '.private');
  await privateDirectory(dataRoot);
  if ((await entries(target)).length) return privateDirectory(target);
  const previous = migrate && source ? await entries(source) : [];
  if (!previous.some(name => ['config.json', 'account.json', 'queue.json'].includes(name))) return privateDirectory(target);
  const release = await acquireLock(source).catch(error => { if (error.message === 'service_already_running') throw Error('legacy_bridge_running'); throw error; });
  const staging = join(dataRoot, `.import-${bridge.id}-${randomUUID()}`);
  try {
    await privateDirectory(staging);
    await cp(source, staging, { recursive: true, filter: async path => {
      if (path === join(source, 'service.lock') || path.endsWith('.tmp')) return false;
      if ((await lstat(path)).isSymbolicLink()) throw Error('migration_symlink_not_supported');
      return true;
    } });
    // Only replace an empty directory; never overwrite an existing profile.
    if ((await entries(target)).length) throw Error('migration_target_not_empty');
    await rmdir(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rename(staging, target); await privateDirectory(target);
    log(`已导入${bridge.name}的旧配置、登录及队列；原目录保留。`);
  } finally {
    await release();
    const checked = resolve(staging);
    if (!checked.startsWith(dataRoot + sep) || dirname(checked) !== dataRoot) throw Error('invalid_migration_path');
    await rm(checked, { recursive: true, force: true });
  }
  return target;
}
export async function configurationState(bridge, root) {
  const config = await readJson(join(root, 'config.json'), null), account = await readJson(join(root, 'account.json'), null);
  let running = false;
  try {
    const { readFile } = await import('node:fs/promises');
    const pid = Number(await readFile(join(root, 'service.lock'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); running = true; }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  return { configured: bridge.configured(config, account), running, port: config?.port ?? bridge.port };
}
