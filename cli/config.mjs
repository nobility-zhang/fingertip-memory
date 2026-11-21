import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CliError } from './errors.mjs';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080/api/v1';
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function normalizeServerUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CliError('CLI_SERVER_INVALID', '服务器地址必须使用 http 或 https');
  }
  parsed.hash = '';
  parsed.search = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/api/v1')) {
    pathname = `${pathname}/api/v1`.replace(/\/+/g, '/');
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, '');
}

export function resolveRuntimeConfig(global, defaultMode = 'local') {
  const mode = global.mode ?? defaultMode;
  if (!['local', 'account'].includes(mode)) {
    throw new CliError('CLI_MODE_INVALID', '模式只能是 local 或 account');
  }
  const profile = global.profile ?? 'default';
  if (!PROFILE_PATTERN.test(profile)) {
    throw new CliError(
      'CLI_PROFILE_INVALID',
      '配置名只能包含字母、数字、点、下划线和连字符，且最长 64 个字符',
    );
  }
  const home = resolve(
    expandHome(global.home ?? process.env.FINGER_MEMORY_HOME ?? join(homedir(), '.finger-memory')),
  );
  const profileDirectory = join(home, 'profiles', mode, profile);
  return {
    mode,
    profile,
    home,
    profileDirectory,
    statePath: join(profileDirectory, 'state.json'),
    configPath: join(profileDirectory, 'config.json'),
    tokenPath: join(profileDirectory, 'token'),
    explicitServer: global.server,
  };
}

export async function loadAccountConfig(runtime) {
  const fileConfig = await readJsonIfPresent(runtime.configPath, {});
  const tokenFromEnvironment = process.env.FINGER_MEMORY_TOKEN?.trim();
  const tokenFromFile = tokenFromEnvironment
    ? undefined
    : await readTextIfPresent(runtime.tokenPath);
  const serverUrl = normalizeServerUrl(
    runtime.explicitServer
      ?? process.env.FINGER_MEMORY_SERVER
      ?? fileConfig.serverUrl
      ?? DEFAULT_SERVER_URL,
  );
  return {
    ...runtime,
    serverUrl,
    token: tokenFromEnvironment || tokenFromFile?.trim() || undefined,
    tokenSource: tokenFromEnvironment ? 'environment' : tokenFromFile ? 'file' : 'none',
    tokenId: fileConfig.tokenId,
    tokenName: fileConfig.tokenName,
    tokenExpiresAtMs: fileConfig.tokenExpiresAtMs,
  };
}

export async function saveAccountSession(runtime, input) {
  await ensurePrivateDirectory(runtime.profileDirectory);
  const serverUrl = normalizeServerUrl(input.serverUrl);
  await writeFileAtomic(
    runtime.configPath,
    `${JSON.stringify({
      serverUrl,
      tokenId: input.tokenId ?? null,
      tokenName: input.tokenName ?? null,
      tokenExpiresAtMs: input.tokenExpiresAtMs ?? null,
      updatedAtMs: Date.now(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFileAtomic(runtime.tokenPath, `${input.token.trim()}\n`, { mode: 0o600 });
}

export async function removeAccountToken(runtime) {
  await removeFileIfPresent(runtime.tokenPath);
}

export async function removeFileIfPresent(path) {
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writeFileAtomic(path, content, { mode = 0o600 } = {}) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function readJsonIfPresent(path, fallback) {
  const content = await readTextIfPresent(path);
  if (content === undefined) {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new CliError(
      'CLI_CONFIG_CORRUPT',
      `配置文件无法解析：${path}`,
      { cause: error },
    );
  }
}

export async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function expandHome(path) {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
