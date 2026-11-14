export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIGURATION_ERROR", cause);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "DATABASE_ERROR", cause);
  }
}

export class ScraperError extends AppError {
  constructor(message: string, public readonly url?: string, cause?: unknown) {
    super(message, "SCRAPER_ERROR", cause);
  }
}

export class NotificationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "NOTIFICATION_ERROR", cause);
  }
}
