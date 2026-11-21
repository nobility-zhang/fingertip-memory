import { randomUUID } from 'node:crypto';

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function createIdempotencyKey(prefix = 'action') {
  return createId(prefix);
}
