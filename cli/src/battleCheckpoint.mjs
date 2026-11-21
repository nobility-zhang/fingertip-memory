import {
  readJsonIfPresent,
  removeFileIfPresent,
  writeFileAtomic,
} from './config.mjs';
import { join } from 'node:path';

export class BattleCheckpointStore {
  constructor(runtime) {
    this.path = join(runtime.profileDirectory, 'battle-claims.json');
  }

  async get(battleId) {
    const records = await readJsonIfPresent(this.path, {});
    return records[battleId];
  }

  async set(battleId, record) {
    const records = await readJsonIfPresent(this.path, {});
    records[battleId] = record;
    await writeFileAtomic(this.path, `${JSON.stringify(records, null, 2)}\n`);
  }

  async clear(battleId) {
    const records = await readJsonIfPresent(this.path, {});
    delete records[battleId];
    if (Object.keys(records).length === 0) {
      await removeFileIfPresent(this.path);
    } else {
      await writeFileAtomic(this.path, `${JSON.stringify(records, null, 2)}\n`);
    }
  }
}
