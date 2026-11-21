import { ApiError } from './errors.mjs';

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class AccountApiClient {
  constructor({ serverUrl, token, fetchImplementation = fetch }) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchImplementation = fetchImplementation;
  }

  async currentUser() {
    return this.request('/auth/me');
  }

  async listLexicons() {
    return this.request('/lexicons?limit=100');
  }

  async createLexicon(name, description = '') {
    return this.request('/lexicons', {
      method: 'POST',
      body: { name, description },
      retry: false,
    });
  }

  async addWord(lexiconId, word) {
    return this.request(`/lexicons/${encodeURIComponent(lexiconId)}/words`, {
      method: 'POST',
      body: word,
      retry: false,
    });
  }

  async loadQueuePlan({ timeZone, newLimit, reviewLimit }) {
    const query = new URLSearchParams({ timeZone });
    if (newLimit !== undefined) {
      query.set('newLimit', String(newLimit));
    }
    if (reviewLimit !== undefined) {
      query.set('reviewLimit', String(reviewLimit));
    }
    return this.request(`/queue/plan?${query}`);
  }

  async listActiveSessions() {
    return this.request('/sessions');
  }

  async createSession(input) {
    return this.request('/sessions', {
      method: 'POST',
      body: input,
      retry: false,
    });
  }

  async getSession(sessionId) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  async updateSession(input) {
    return this.request(`/sessions/${encodeURIComponent(input.sessionId)}`, {
      method: 'PATCH',
      body: {
        expectedDataVersion: input.expectedDataVersion,
        expectedVersion: input.expectedVersion,
        status: input.status,
      },
    });
  }

  async submitPracticeResponse(input) {
    return this.request(
      `/sessions/${encodeURIComponent(input.sessionId)}/responses`,
      {
        method: 'POST',
        body: input.body,
        retry: true,
      },
    );
  }

  async completePractice(input) {
    return this.request(
      `/sessions/${encodeURIComponent(input.sessionId)}/practice`,
      {
        method: 'POST',
        body: input.body,
        retry: true,
      },
    );
  }

  async previewReview(input) {
    return this.request(
      `/sessions/${encodeURIComponent(input.sessionId)}/review-preview`,
      {
        method: 'POST',
        body: input.body,
        retry: true,
      },
    );
  }

  async submitReview(input) {
    return this.request(
      `/sessions/${encodeURIComponent(input.sessionId)}/reviews`,
      {
        method: 'POST',
        idempotencyKey: input.submissionId,
        body: input.body,
        retry: true,
      },
    );
  }

  async createBattle(input) {
    return this.request('/battles', {
      method: 'POST',
      idempotencyKey: input.actionId,
      body: input.body,
      retry: true,
    });
  }

  async getBattle(battleId) {
    return this.request(`/battles/${encodeURIComponent(battleId)}`);
  }

  async listActiveBattles(limit = 20) {
    return this.request(`/battles?limit=${encodeURIComponent(String(limit))}`);
  }

  async claimBattleLearning(input) {
    return this.battleCommand(input.battleId, 'learning-claims', input);
  }

  async playBattleCard(input) {
    return this.battleCommand(input.battleId, 'cards', input);
  }

  async useBattleCompanionSkill(input) {
    return this.battleCommand(input.battleId, 'companion-skill', input);
  }

  async endBattleTurn(input) {
    return this.battleCommand(input.battleId, 'end-turn', input);
  }

  async listAdventures(limit = 20) {
    return this.request(`/adventures?limit=${encodeURIComponent(String(limit))}`);
  }

  async listContentPackages(limit = 50) {
    return this.request(
      `/content-packages?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async listAdventureCompletions(limit = 50) {
    return this.request(
      `/adventures/completions?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async startAdventure(input) {
    return this.request('/adventures', {
      method: 'POST',
      idempotencyKey: input.actionId,
      body: {
        installationId: input.installationId,
        companionKey: input.companionKey,
        sourceCompletionId: input.sourceCompletionId,
        reduceMotion: true,
      },
      retry: true,
    });
  }

  async getAdventure(runId) {
    return this.request(`/adventures/${encodeURIComponent(runId)}`);
  }

  async upgradeAdventure(input) {
    return this.request(
      `/adventures/${encodeURIComponent(input.runId)}/upgrade`,
      {
        method: 'POST',
        idempotencyKey: input.actionId,
        body: { installationId: input.installationId },
        retry: true,
      },
    );
  }

  async startAdventureEncounter(input) {
    return this.request(
      `/adventures/${encodeURIComponent(input.runId)}/encounters`,
      {
        method: 'POST',
        idempotencyKey: input.actionId,
        retry: true,
      },
    );
  }

  async actAdventure(input) {
    return this.request(
      `/adventures/${encodeURIComponent(input.runId)}/actions`,
      {
        method: 'POST',
        idempotencyKey: input.actionId,
        body: input.body,
        retry: true,
      },
    );
  }

  async exportBackup() {
    return this.request('/backup/export');
  }

  async previewBackupImport(backup) {
    return this.request('/backup/import/preview', {
      method: 'POST',
      body: { backup },
      retry: false,
    });
  }

  async importBackup(backup, idempotencyKey) {
    return this.request('/backup/import', {
      method: 'POST',
      idempotencyKey,
      body: { backup },
      retry: true,
    });
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET';
    const attempts = options.retry ? 3 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce(path, { ...options, method });
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= attempts || !isRetryable(error)) {
          throw error;
        }
        await delay(150 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async requestOnce(path, options) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (options.idempotencyKey) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }
    let body;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchImplementation(
      `${this.serverUrl}${path}`,
      { method: options.method, headers, body },
    );
    let payload;
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        payload?.code ?? 'REQUEST_FAILED',
        payload?.message ?? `请求失败（HTTP ${response.status}）`,
        payload,
      );
    }
    return payload;
  }

  async battleCommand(battleId, suffix, input) {
    return this.request(
      `/battles/${encodeURIComponent(battleId)}/${suffix}`,
      {
        method: 'POST',
        idempotencyKey: input.actionId,
        body: input.body,
        retry: true,
      },
    );
  }
}

function isRetryable(error) {
  return error instanceof ApiError
    ? RETRYABLE_STATUS.has(error.status)
    : error instanceof TypeError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
