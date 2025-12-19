/**
 * Environment variable validation and access
 * Fails fast if required variables are missing
 */

interface EnvConfig {
  // Pipedrive
  pipedrive: {
    apiKey: string;
    companyDomain: string;
    systemUserId: string;
  };
  // Quo (OpenPhone)
  quo: {
    apiKey: string;
    webhookSecret: string;
  };
  // Redis
  redis: {
    url: string;
    token: string;
  };
  // Environment
  nodeEnv: 'development' | 'production';
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

let cachedConfig: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    pipedrive: {
      apiKey: requireEnv('PIPEDRIVE_API_KEY'),
      companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
      systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
    },
    quo: {
      apiKey: requireEnv('QUO_API_KEY'),
      webhookSecret: requireEnv('QUO_WEBHOOK_SECRET'),
    },
    redis: {
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    },
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production') || 'development',
  };

  return cachedConfig;
}

/**
 * Check if we're in production
 */
export function isProduction(): boolean {
  return getEnv().nodeEnv === 'production';
}
