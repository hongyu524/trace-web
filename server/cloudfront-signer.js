import fs from 'node:fs';
import path from 'node:path';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || '';
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID || '';
const CLOUDFRONT_PRIVATE_KEY_PATH = process.env.CLOUDFRONT_PRIVATE_KEY_PATH || '';
const CLOUDFRONT_PRIVATE_KEY_PEM = process.env.CLOUDFRONT_PRIVATE_KEY_PEM || '';
const DEFAULT_TTL_SECONDS = Number(process.env.CLOUDFRONT_URL_TTL_SECONDS || 3600);

let cachedPrivateKey = null;

function loadPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;

  if (CLOUDFRONT_PRIVATE_KEY_PEM) {
    cachedPrivateKey = CLOUDFRONT_PRIVATE_KEY_PEM;
    return cachedPrivateKey;
  }

  if (CLOUDFRONT_PRIVATE_KEY_PATH) {
    const resolved = path.resolve(CLOUDFRONT_PRIVATE_KEY_PATH);
    cachedPrivateKey = fs.readFileSync(resolved, 'utf8');
    return cachedPrivateKey;
  }

  throw new Error('CLOUDFRONT private key not provided (set CLOUDFRONT_PRIVATE_KEY_PEM or CLOUDFRONT_PRIVATE_KEY_PATH)');
}

function validatePath(resourcePath) {
  if (typeof resourcePath !== 'string') {
    throw new Error('path must be a string');
  }
  if (resourcePath.length === 0 || resourcePath.length > 2048) {
    throw new Error('path length invalid');
  }
  if (!resourcePath.startsWith('/videos/')) {
    throw new Error('path must start with /videos/');
  }
  if (resourcePath.includes('..')) {
    throw new Error('path contains invalid sequence');
  }
}

export function signVideoPath(resourcePath, options = {}) {
  validatePath(resourcePath);

  if (!CLOUDFRONT_DOMAIN) {
    throw new Error('CLOUDFRONT_DOMAIN not configured');
  }
  if (!CLOUDFRONT_KEY_PAIR_ID) {
    throw new Error('CLOUDFRONT_KEY_PAIR_ID not configured');
  }

  const privateKey = loadPrivateKey();
  const ttlSeconds = Number(options.ttlSeconds || DEFAULT_TTL_SECONDS || 0) || DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const url = `https://${CLOUDFRONT_DOMAIN}${resourcePath}`;

  const signedUrl = getSignedUrl({
    url,
    keyPairId: CLOUDFRONT_KEY_PAIR_ID,
    privateKey,
    dateLessThan: expiresAt,
  });

  return { signedUrl, expiresInSeconds: ttlSeconds, url };
}














