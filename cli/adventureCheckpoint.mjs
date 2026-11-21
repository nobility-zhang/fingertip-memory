import { join } from 'node:path';
import {
  readJsonIfPresent,
  removeFileIfPresent,
  writeFileAtomic,
} from './config.mjs';

export class AdventureCheckpointStore {
  constructor(runtime) {
    this.path = join(runtime.profileDirectory, 'adventure-actions.json');
  }

  async get(runId) {
    const records = await readJsonIfPresent(this.path, {});
    return records[runId];
  }

  async set(runId, record) {
    const records = await readJsonIfPresent(this.path, {});
    records[runId] = record;
    await writeFileAtomic(this.path, `${JSON.stringify(records, null, 2)}\n`);
  }

  async clear(runId) {
    const records = await readJsonIfPresent(this.path, {});
    delete records[runId];
    if (Object.keys(records).length === 0) {
      await removeFileIfPresent(this.path);
    } else {
      await writeFileAtomic(this.path, `${JSON.stringify(records, null, 2)}\n`);
    }
  }
}
