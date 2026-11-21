import { hostname } from 'node:os';
import { AccountApiClient } from '../api.mjs';
import {
  loadAccountConfig,
  normalizeServerUrl,
  removeAccountToken,
  resolveRuntimeConfig,
  saveAccountSession,
} from '../config.mjs';
import { CliError } from '../errors.mjs';
import { parseCommandArgs } from '../args.mjs';

const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export async function runAuth({ global, words, terminal }) {
  const command = words[0];
  if (command === undefined) {
    terminal.write('用法：fm --mode account auth login|status|set-token|logout');
    return;
  }
  const runtime = resolveRuntimeConfig(
    { ...global, mode: 'account' },
    'account',
  );
  if (command === 'login') {
    const { options } = parseCommandArgs(words.slice(1), {
      values: ['name'],
      positionals: 0,
    });
    await loginAndCreateToken(runtime, terminal, options.name);
    return;
  }
  if (command === 'status') {
    parseCommandArgs(words.slice(1), { positionals: 0 });
    const config = await requireAccountConfig(runtime);
    const user = await new AccountApiClient(config).currentUser();
    if (terminal.json) {
      terminal.printJson({
        serverUrl: config.serverUrl,
        profile: config.profile,
        tokenSource: config.tokenSource,
        user,
      });
    } else {
      terminal.write(
        `已连接 ${config.serverUrl} · ${user.displayName} (@${user.username})`,
      );
      terminal.write(
        `配置 ${config.profile} · 令牌来源 ${config.tokenSource}`,
      );
    }
    return;
  }
  if (command === 'set-token') {
    parseCommandArgs(words.slice(1), { positionals: 0 });
    const environmentToken = process.env.FINGER_MEMORY_TOKEN?.trim();
    const token = environmentToken || await terminal.secret('个人访问令牌：');
    if (token === undefined || !token.startsWith('fm_pat_')) {
      throw new CliError('CLI_TOKEN_INVALID', '访问令牌格式无效');
    }
    const provisional = await loadAccountConfig({
      ...runtime,
      explicitServer: global.server,
    });
    const user = await new AccountApiClient({
      serverUrl: provisional.serverUrl,
      token,
    }).currentUser();
    await saveAccountSession(runtime, {
      serverUrl: provisional.serverUrl,
      token,
      tokenName: `manual-${user.username}`,
    });
    terminal.write(`令牌已保存到 ${runtime.tokenPath}（权限 0600）`);
    return;
  }
  if (command === 'logout') {
    parseCommandArgs(words.slice(1), { positionals: 0 });
    await removeAccountToken(runtime);
    terminal.write('本机访问令牌已移除；远端令牌仍可在 Web 账号页撤销。');
    return;
  }
  throw new CliError('CLI_COMMAND_UNKNOWN', `未知 auth 命令：${command}`);
}

async function loginAndCreateToken(runtime, terminal, tokenName) {
  const username = process.env.FINGER_MEMORY_USERNAME?.trim()
    || await terminal.question('用户名：');
  const password = process.env.FINGER_MEMORY_PASSWORD
    || await terminal.secret('密码：');
  if (!username || !password) {
    throw new CliError('CLI_CREDENTIAL_REQUIRED', '用户名和密码不能为空');
  }

  const apiBaseUrl = normalizeServerUrl(
    runtime.explicitServer
      ?? process.env.FINGER_MEMORY_SERVER
      ?? 'http://127.0.0.1:8080/api/v1',
  );
  const session = new CookieSession(apiBaseUrl);
  const csrf = await session.readCsrf();
  const login = await session.request('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      [csrf.headerName]: csrf.token,
    },
    body: new URLSearchParams({ username, password }).toString(),
  });
  if (!login.ok) {
    const body = await readJson(login);
    throw new CliError(
      body?.code ?? 'AUTH_LOGIN_FAILED',
      body?.message ?? '登录失败',
    );
  }
  const user = await readJson(login);
  if (user?.mustChangePassword) {
    throw new CliError(
      'PASSWORD_CHANGE_REQUIRED',
      '请先在 Web 中修改首次登录密码，再创建 CLI 令牌',
    );
  }

  const renewedCsrf = await session.readCsrf();
  const createdAt = Date.now();
  const response = await session.request('/auth/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [renewedCsrf.headerName]: renewedCsrf.token,
    },
    body: JSON.stringify({
      name: tokenName ?? `CLI ${hostname()}`.slice(0, 80),
      expiresAtMs: createdAt + TOKEN_LIFETIME_MS,
    }),
  });
  const created = await readJson(response);
  if (!response.ok) {
    throw new CliError(
      created?.code ?? 'AUTH_TOKEN_CREATE_FAILED',
      created?.message ?? '无法创建 CLI 访问令牌',
    );
  }

  await saveAccountSession(runtime, {
    serverUrl: apiBaseUrl,
    token: created.plaintextToken,
    tokenId: created.token.id,
    tokenName: created.token.name,
    tokenExpiresAtMs: created.token.expiresAtMs,
  });
  terminal.event('TOKEN_CREATED', {
    profile: runtime.profile,
    token: created.token.name,
    prefix: created.token.prefix,
    expiresAt: new Date(created.token.expiresAtMs).toISOString(),
  });
  terminal.write(`令牌已保存到 ${runtime.tokenPath}（权限 0600）`);
}

async function requireAccountConfig(runtime) {
  const config = await loadAccountConfig(runtime);
  if (!config.token) {
    throw new CliError(
      'CLI_TOKEN_MISSING',
      '账号模式尚未配置令牌，请先运行 fm --mode account auth login',
    );
  }
  return config;
}

class CookieSession {
  constructor(serverUrl) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.cookies = new Map();
  }

  async readCsrf() {
    const response = await this.request('/auth/csrf');
    if (!response.ok) {
      throw new CliError('AUTH_CSRF_FAILED', '无法建立安全登录会话');
    }
    return response.json();
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const response = await fetch(`${this.serverUrl}${path}`, {
      ...options,
      headers,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(
          pair.slice(0, separator),
          pair.slice(separator + 1),
        );
      }
    }
    return response;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export { CookieSession, requireAccountConfig };
