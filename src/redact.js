// Strip secrets before anything reaches disk. Patterns favour false positives over leaks.
const R = '[REDACTED]';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  // Provider keys by prefix (see test/redact-corpus.test.js for a sample of each).
  [/\bsk-[A-Za-z0-9_-]{20,}/g, R], // OpenAI, Anthropic, DeepSeek
  [/\bxai-[A-Za-z0-9]{20,}/g, R], // xAI
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R], // Google / Gemini
  [/\b(?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R], // Stripe
  [/\bwhsec_[A-Za-z0-9]{10,}/g, R], // Stripe webhook secret
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, R], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R], // GitLab
  [/\bnpm_[A-Za-z0-9]{30,}/g, R], // npm
  [/\bhf_[A-Za-z0-9]{30,}/g, R], // Hugging Face
  [/\bSG\.[\w-]{16,}\.[\w-]{16,}/g, R], // SendGrid
  [/\bAKIA[0-9A-Z]{16}\b/g, R], // AWS access key id
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R], // Slack tokens
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, `$1${R}`], // Slack webhooks
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, R], // JWT
  [/\b(Bearer\s+)[\w.~+/=-]{16,}/gi, `$1${R}`],
  [/(\bAuthorization["']?\s*[=:]\s*["']?Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, `$1${R}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, `$1${R}$2`], // passwords in URLs
  // name = value, name: value, "name": "value" (env files, YAML, JSON, JS objects, HTTP headers).
  // A value stops at whitespace, a quote or ";" (connection strings).
  [
    /\b([A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|ACCOUNT[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_-]*)(["']?\s*[=:]\s*)(["']?)[^\s"';]+\3/gi,
    `$1$2$3${R}$3`,
  ],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  return PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), text);
}

export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
