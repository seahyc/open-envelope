import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from './codex-defaults.js';
import { flagOn } from './context-flags.js';

export interface Config {
  port: number;
  databasePath: string;
  objectStorageType: 'local' | 's3';
  objectStorageLocalPath: string;
  objectStorageS3Endpoint?: string;
  objectStorageS3Bucket?: string;
  objectStorageS3AccessKeyId?: string;
  objectStorageS3SecretAccessKey?: string;
  objectStorageS3Region?: string;
  authMode: 'header' | 'none' | 'session';
  authHeaderName: string;
  cfAccessTeamDomain?: string;
  cfAccessAud?: string;
  allowedEmails: string[];
  accessGate: boolean;
  appMode: 'hosted' | 'selfhost';
  googleClientId?: string;
  googleClientSecret?: string;
  /** Opt-in. Google + magic-link sign-up stay off unless AUTH_SIGNUP is truthy *and* AUTH_MODE=session. */
  authSignup: boolean;
  authMagicCapture: boolean;
  sessionCookieSecure: boolean;
  ingestApiKey?: string;
  emailIngestHmacSecret?: string;
  emailIngestDomain?: string;
  publicOrigin?: string;
  logLevel: string;
  demoMode: boolean;
  llmProvider: 'none' | 'codex' | 'openai';
  llmHouseholdDailyCap: number;
  llmCodexBin?: string;
  llmCodexHome?: string;
  llmCacheEnabled: boolean;
  llmTimeout: number;
  llmRateLimit: number;
  codexModel?: string;
  codexReasoningEffort?: string;
}

export function loadConfig(): Config {
  const allowedEmailsStr = process.env.ALLOWED_EMAILS || '';
  const allowedEmails = allowedEmailsStr ? allowedEmailsStr.split(',').map(e => e.trim()) : [];
  
  return {
    port: parseInt(process.env.PORT || '3100'),
    databasePath: process.env.DATABASE_PATH || './data/openenvelope.db',
    objectStorageType: (process.env.OBJECT_STORAGE_TYPE || 'local') as 'local' | 's3',
    objectStorageLocalPath: process.env.OBJECT_STORAGE_LOCAL_PATH || './data/documents',
    objectStorageS3Endpoint: process.env.OBJECT_STORAGE_S3_ENDPOINT,
    objectStorageS3Bucket: process.env.OBJECT_STORAGE_S3_BUCKET,
    objectStorageS3AccessKeyId: process.env.OBJECT_STORAGE_S3_ACCESS_KEY_ID,
    objectStorageS3SecretAccessKey: process.env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY,
    objectStorageS3Region: process.env.OBJECT_STORAGE_S3_REGION || 'auto',
    authMode: (process.env.AUTH_MODE || 'header') as 'header' | 'none' | 'session',
    authHeaderName: process.env.AUTH_HEADER_NAME || 'X-Auth-User',
    cfAccessTeamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    cfAccessAud: process.env.CF_ACCESS_AUD,
    allowedEmails,
    accessGate: process.env.ACCESS_GATE === '1' || process.env.ACCESS_GATE === 'true',
    appMode: (process.env.APP_MODE || 'selfhost') as 'hosted' | 'selfhost',
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authSignup: flagOn('AUTH_SIGNUP'),
    authMagicCapture: process.env.AUTH_MAGIC_CAPTURE === '1' || process.env.AUTH_MAGIC_CAPTURE === 'true',
    sessionCookieSecure: process.env.NODE_ENV === 'production',
    ingestApiKey: process.env.INGEST_API_KEY,
    emailIngestHmacSecret: process.env.EMAIL_INGEST_HMAC_SECRET,
    emailIngestDomain: process.env.EMAIL_INGEST_DOMAIN,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    logLevel: process.env.LOG_LEVEL || 'info',
    demoMode: process.env.DEMO_MODE === 'true',
    llmProvider: (process.env.LLM_PROVIDER || 'none') as 'none' | 'codex' | 'openai',
    llmHouseholdDailyCap: parseInt(process.env.LLM_HOUSEHOLD_DAILY_CAP || '50', 10),
    llmCodexBin: process.env.CODEX_BIN || 'codex',
    llmCodexHome: process.env.CODEX_HOME,
    llmCacheEnabled: process.env.LLM_CACHE_ENABLED !== 'false',
    llmTimeout: parseInt(process.env.LLM_TIMEOUT || '30000'),
    llmRateLimit: parseInt(process.env.LLM_RATE_LIMIT || '10'),
    codexModel: process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL,
    codexReasoningEffort: process.env.CODEX_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT,
  };
}
