export class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
  }
}

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function describeError(error) {
  if (error instanceof CliError || error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '操作失败，请稍后重试';
}
