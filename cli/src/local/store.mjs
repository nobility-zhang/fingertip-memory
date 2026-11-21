import { chmod, copyFile, readFile, stat } from 'node:fs/promises';
import {
  ensurePrivateDirectory,
  writeFileAtomic,
} from '../config.mjs';
import { CliError } from '../errors.mjs';
import {
  createEmptySnapshot,
  parseSnapshot,
  snapshotCounts,
} from './schema.mjs';

export class LocalStore {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async load() {
    const text = await readOptional(this.runtime.statePath);
    if (text === undefined) {
      return createEmptySnapshot();
    }
    try {
      return parseSnapshot(JSON.parse(text));
    } catch (primaryError) {
      const backup = await readOptional(`${this.runtime.statePath}.bak`);
      if (backup !== undefined) {
        try {
          return parseSnapshot(JSON.parse(backup));
        } catch {
          // Report the primary failure below; the backup is diagnostics only.
        }
      }
      throw new CliError(
        'CLI_LOCAL_STATE_CORRUPT',
        `本地状态无法恢复：${this.runtime.statePath}`,
        { cause: primaryError },
      );
    }
  }

  async save(snapshot) {
    parseSnapshot(snapshot);
    snapshot.exportedAt = Date.now();
    await ensurePrivateDirectory(this.runtime.profileDirectory);
    const existing = await readOptional(this.runtime.statePath);
    if (existing !== undefined) {
      await writeFileAtomic(`${this.runtime.statePath}.bak`, existing);
    }
    await writeFileAtomic(
      this.runtime.statePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }

  async importSnapshot(input) {
    const snapshot = parseSnapshot(input);
    snapshot.exportedAt = Date.now();
    const existing = await readOptional(this.runtime.statePath);
    if (existing !== undefined) {
      const archived = `${this.runtime.statePath}.pre-import-${Date.now()}`;
      await writeFileAtomic(archived, existing);
    }
    await writeFileAtomic(
      this.runtime.statePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    return snapshot;
  }

  async exportSnapshot(outputPath) {
    const snapshot = await this.load();
    snapshot.exportedAt = Date.now();
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (outputPath) {
      await writeFileAtomic(outputPath, text, { mode: 0o600 });
      return { snapshot, outputPath };
    }
    return { snapshot, text };
  }

  async status() {
    const snapshot = await this.load();
    let fileBytes = 0;
    let mode = 'missing';
    try {
      const info = await stat(this.runtime.statePath);
      fileBytes = info.size;
      mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    return {
      profile: this.runtime.profile,
      path: this.runtime.statePath,
      mode,
      bytes: fileBytes,
      counts: snapshotCounts(snapshot),
    };
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
