#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGlobalArgs } from './args.mjs';
import { resolveRuntimeConfig } from './config.mjs';
import { ApiError, CliError, describeError } from './errors.mjs';
import { Terminal } from './terminal.mjs';
import { runAdventure } from './commands/adventure.mjs';
import { runAuth } from './commands/auth.mjs';
import { runBattle } from './commands/battle.mjs';
import { runData } from './commands/data.mjs';
import { runLearn } from './commands/learn.mjs';
import { runLexicon } from './commands/lexicon.mjs';

const VERSION = '2.0.0';

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseGlobalArgs(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.global.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.global.help || parsed.words.length === 0) {
    printHelp(process.stdout);
    return;
  }
  const terminal = new Terminal({ json: parsed.global.json });
  const [command, ...words] = parsed.words;
  try {
    if (command === 'auth') {
      await runAuth({ global: parsed.global, words, terminal });
    } else if (command === 'adventure') {
      await runAdventure({ global: parsed.global, words, terminal });
    } else if (command === 'learn') {
      await runLearn({ global: parsed.global, words, terminal });
    } else if (command === 'battle') {
      await runBattle({ global: parsed.global, words, terminal });
    } else if (command === 'lexicon' || command === 'lexicons') {
      await runLexicon({ global: parsed.global, words, terminal });
    } else if (command === 'data' || command === 'backup') {
      await runData({ global: parsed.global, words, terminal });
    } else if (command === 'profile') {
      await runProfile({ global: parsed.global, words, terminal });
    } else if (command === 'help') {
      printHelp(terminal.output);
    } else {
      throw new CliError('CLI_COMMAND_UNKNOWN', `未知命令：${command}`);
    }
  } catch (error) {
    terminal.close();
    if (error instanceof CliError && error.code === 'CLI_BATTLE_PAUSED') {
      terminal.write(error.message);
      return;
    }
    if (terminal.json) {
      terminal.printJson({
        error: {
          code: error instanceof CliError || error instanceof ApiError
            ? error.code
            : 'CLI_FAILED',
          message: describeError(error),
        },
      });
    } else {
      process.stderr.write(`错误：${describeError(error)}\n`);
      if (process.env.FINGER_MEMORY_DEBUG === '1' && error instanceof Error) {
        process.stderr.write(`${error.stack}\n`);
      }
    }
    process.exitCode = 1;
  } finally {
    terminal.close();
  }
}

async function runProfile({ global, words, terminal }) {
  const command = words[0] ?? 'list';
  if (command !== 'list') {
    throw new CliError('CLI_COMMAND_UNKNOWN', '用法：fm profile list');
  }
  if (words.length > 1) {
    throw new CliError('CLI_ARGUMENT_UNEXPECTED', 'profile list 不接受额外参数');
  }
  const runtime = resolveRuntimeConfig(global);
  const profiles = [];
  for (const mode of ['local', 'account']) {
    const directory = join(runtime.home, 'profiles', mode);
    const names = await readDirectoryNames(directory);
    for (const name of names) {
      profiles.push({ mode, profile: name });
    }
  }
  if (terminal.json) {
    terminal.printJson(profiles);
    return;
  }
  if (profiles.length === 0) {
    terminal.write('还没有本地或账号配置。');
    return;
  }
  profiles.forEach((profile, index) => {
    terminal.event('PROFILE', { index: index + 1, ...profile });
  });
}

async function readDirectoryNames(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function printHelp(output) {
  output.write(`FingerMemory CLI ${VERSION}

用法：
  fm [--mode local|account] [--profile NAME] [--json] <命令>

命令：
  auth login             交互登录并在本机保存个人访问令牌
  auth status            校验账号服务器与令牌
  auth set-token         从隐藏输入或环境读取令牌
  auth logout            移除本机令牌
  adventure books        列出已安装冒险与前置结局
  adventure list         列出进行中的冒险
  adventure show [ID]    查看文本检查点
  adventure start        启动固定版本冒险
  adventure resume [ID]  进入文字剧情与遭遇
  lexicon list           列出词库
  lexicon import FILE    从 TSV 导入词库
  learn                  创建或继续学习会话
  battle list            列出账号活动文字卡牌
  battle --resume        恢复最近文字卡牌
  battle                 创建或恢复文字卡牌战斗
  data status            查看当前模式数据状态
  data export            导出 v5 本地快照或账号备份
  data import FILE       校验并恢复本地或账号备份
  profile list           列出本机和账号配置

全局环境：
  FINGER_MEMORY_HOME     配置根目录，默认 ~/.finger-memory
  FINGER_MEMORY_TOKEN    账号模式令牌，优先于本机 token 文件
  FINGER_MEMORY_SERVER   账号 API 地址
  FINGER_MEMORY_USERNAME 非交互登录用户名
  FINGER_MEMORY_PASSWORD 非交互登录密码（仅当前进程）
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
