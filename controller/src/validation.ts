import { URL } from 'url';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Configure allowed domains via environment variable
const ALLOWED_CODE_DOMAINS = process.env.ALLOWED_CODE_DOMAINS
  ? process.env.ALLOWED_CODE_DOMAINS.split(',').map(d => d.trim())
  : [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      // Add your artifact registry domain
      // 'your-project.storage.googleapis.com'
    ];

// Private IP ranges (CIDR notation)
const PRIVATE_IP_RANGES = [
  /^10\./,                    // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./,              // 192.168.0.0/16
  /^127\./,                   // 127.0.0.0/8 (loopback)
  /^169\.254\./,              // 169.254.0.0/16 (link-local)
  /^::1$/,                    // IPv6 loopback
  /^fe80:/,                   // IPv6 link-local
  /^fc00:/,                   // IPv6 private
];

function isPrivateIP(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(hostname));
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateCodeUrl(code_url: string): ValidationResult {
  // Check type
  if (typeof code_url !== 'string') {
    return { valid: false, error: 'code_url must be a string' };
  }

  // Check length
  if (code_url.length > 2048) {
    return { valid: false, error: 'code_url exceeds maximum length' };
  }

  // Parse URL
  let url: URL;
  try {
    url = new URL(code_url);
  } catch (err) {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  const allowedProtocols = ['http:', 'https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    log.warn({ protocol: url.protocol, url: code_url }, 'Blocked code_url with disallowed protocol');
    return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  // Check for private IPs
  if (isPrivateIP(url.hostname)) {
    log.warn({ hostname: url.hostname, url: code_url }, 'Blocked code_url pointing to private IP');
    return { valid: false, error: 'Private IP addresses are not allowed' };
  }

  // Check domain allowlist
  const isAllowed = ALLOWED_CODE_DOMAINS.some(domain => {
    // Support wildcards like *.github.com
    if (domain.startsWith('*.')) {
      const baseDomain = domain.slice(2);
      return url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain);
    }
    return url.hostname === domain;
  });

  if (!isAllowed) {
    log.warn({ hostname: url.hostname, url: code_url }, 'Blocked code_url from non-allowlisted domain');
    return { valid: false, error: `Domain ${url.hostname} is not in the allowlist` };
  }

  return { valid: true };
}

export function validateCommand(command: string): ValidationResult {
  if (typeof command !== 'string') {
    return { valid: false, error: 'command must be a string' };
  }

  if (command.length === 0) {
    return { valid: false, error: 'command cannot be empty' };
  }

  if (command.length > 1000) {
    return { valid: false, error: 'command exceeds maximum length' };
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    /\$\(/,           // Command substitution
    /`/,              // Backticks
    /\$\{/,           // Variable substitution
    /<\(/,            // Process substitution
    />\(/,            // Process substitution
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { valid: false, error: 'command contains potentially dangerous patterns' };
    }
  }

  return { valid: true };
}

export function validateChecksum(checksum: string): ValidationResult {
  if (!checksum) {
    return { valid: true }; // Checksum is optional
  }

  if (typeof checksum !== 'string') {
    return { valid: false, error: 'checksum must be a string' };
  }

  // SHA-256 is 64 hex characters
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    return { valid: false, error: 'Invalid SHA-256 checksum format' };
  }

  return { valid: true };
}

export function validatePrompt(prompt: string): ValidationResult {
  if (!prompt) {
    return { valid: true }; // Prompt is optional
  }

  if (typeof prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }

  if (prompt.length > 10000) {
    return { valid: false, error: 'prompt exceeds maximum length' };
  }

  return { valid: true };
}
