import { CliError } from './errors.mjs';

const GLOBAL_VALUE_OPTIONS = new Map([
  ['--mode', 'mode'],
  ['--profile', 'profile'],
  ['--home', 'home'],
  ['--server', 'server'],
]);

const GLOBAL_BOOLEAN_OPTIONS = new Map([
  ['--json', 'json'],
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
]);

export function parseGlobalArgs(argv) {
  const global = {};
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const option = equals > 0 ? argument.slice(0, equals) : argument;
    if (GLOBAL_BOOLEAN_OPTIONS.has(option)) {
      global[GLOBAL_BOOLEAN_OPTIONS.get(option)] = true;
      continue;
    }
    const key = GLOBAL_VALUE_OPTIONS.get(option);
    if (key !== undefined) {
      const value = equals > 0 ? argument.slice(equals + 1) : argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError('CLI_OPTION_VALUE_REQUIRED', `${option} 需要一个值`);
      }
      global[key] = value;
      continue;
    }
    words.push(argument);
  }
  if (global.mode !== undefined && !['local', 'account'].includes(global.mode)) {
    throw new CliError('CLI_MODE_INVALID', '--mode 只能是 local 或 account');
  }
  return { global, words };
}

export function parseCommandArgs(
  words,
  { values = [], flags = [], positionals = Infinity } = {},
) {
  const valueOptions = new Set(values);
  const flagOptions = new Set(flags);
  const options = {};
  const positional = [];
  for (let index = 0; index < words.length; index += 1) {
    const argument = words[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals > 0 ? equals : undefined);
    if (flagOptions.has(name)) {
      if (equals > 0) {
        throw new CliError('CLI_FLAG_VALUE_INVALID', `--${name} 不接受值`);
      }
      options[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) {
      throw new CliError('CLI_OPTION_UNKNOWN', `未知选项 --${name}`);
    }
    const value = equals > 0 ? argument.slice(equals + 1) : words[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('CLI_OPTION_VALUE_REQUIRED', `--${name} 需要一个值`);
    }
    options[name] = value;
  }
  if (positional.length > positionals) {
    throw new CliError('CLI_ARGUMENT_UNEXPECTED', `多余参数：${positional[positionals]}`);
  }
  return { options, positional };
}
