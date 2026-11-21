import { createInterface } from 'node:readline/promises';
import { CliError } from './errors.mjs';

export class Terminal {
  constructor({
    input = process.stdin,
    output = process.stdout,
    error = process.stderr,
    json = false,
  } = {}) {
    this.input = input;
    this.output = output;
    this.errorOutput = error;
    this.json = json;
    this.isTTY = Boolean(input.isTTY && output.isTTY);
    this.readline = undefined;
    this.lineIterator = undefined;
    this.closed = false;
  }

  write(message = '') {
    if (!this.json) {
      this.output.write(`${message}\n`);
    }
  }

  event(name, fields = {}) {
    if (this.json) {
      return;
    }
    const suffix = Object.entries(fields)
      .map(([key, value]) => `${key}=${formatField(value)}`)
      .join(' ');
    this.output.write(`${name}${suffix ? ` ${suffix}` : ''}\n`);
  }

  printJson(value) {
    this.output.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  async question(prompt) {
    if (this.closed) {
      return undefined;
    }
    if (!this.isTTY) {
      const next = await this.nonTTYIterator().next();
      return next.done ? undefined : next.value;
    }
    const readline = this.readlineInstance();
    try {
      return await readline.question(this.isTTY && !this.json ? prompt : '');
    } catch (error) {
      if (error.code === 'ERR_USE_AFTER_CLOSE') {
        return undefined;
      }
      throw error;
    }
  }

  async secret(prompt) {
    const readline = this.readlineInstance();
    if (!this.isTTY || !this.input.isTTY) {
      const value = await this.question('');
      return value?.trim();
    }
    readline.pause();
    this.output.write(prompt);
    this.input.setRawMode(true);
    this.input.resume();
    let value = '';
    try {
      return await new Promise((resolve, reject) => {
        const onData = (chunk) => {
          for (const character of chunk.toString('utf8')) {
            if (character === '\u0003') {
              cleanup();
              reject(new CliError('CLI_CANCELLED', '已取消输入'));
              return;
            }
            if (character === '\r' || character === '\n') {
              cleanup();
              this.output.write('\n');
              resolve(value);
              return;
            }
            if (character === '\u007f' || character === '\b') {
              value = value.slice(0, -1);
              continue;
            }
            if (character >= ' ') {
              value += character;
            }
          }
        };
        const cleanup = () => {
          this.input.off('data', onData);
          this.input.setRawMode(false);
          this.input.pause();
          readline.resume();
        };
        this.input.on('data', onData);
      });
    } finally {
      if (this.input.isRaw) {
        this.input.setRawMode(false);
      }
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.readline?.close();
    }
  }

  readlineInstance() {
    this.readline ??= createInterface({
      input: this.input,
      output: this.isTTY && !this.json ? this.output : undefined,
      terminal: this.isTTY,
    });
    return this.readline;
  }

  nonTTYIterator() {
    this.lineIterator ??= this.readlineInstance()[Symbol.asyncIterator]();
    return this.lineIterator;
  }
}

function formatField(value) {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}
