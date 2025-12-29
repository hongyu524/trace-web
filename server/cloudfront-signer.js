import fs from 'node:fs';
import path from 'node:path';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

export function signVideoPath(resourcePath, options = {}) {
  if (typeof resourcePath !== 'string' || !resourcePath.startsWith('/videos/')) {
    throw new Error('Invalid path. Must start with /videos/');
  }

  const domain = mustGetEnv('CLOUDFRONT_DOMAIN');
  const keyPairId = mustGetEnv('CLOUDFRONT_KEY_PAIR_ID');
  const ttl = Number(options.ttlSeconds || process.env.CLOUDFRONT_URL_TTL_SECONDS || '3600');
  const expires = new Date(Date.now() + ttl * 1000);

  const pemFromEnv = process.env.CLOUDFRONT_PRIVATE_KEY_PEM;
  const pemPath =
    process.env.CLOUDFRONT_PRIVATE_KEY_PATH ||
    path.join(process.cwd(), 'secrets', 'cloudfront_private_key.pem');

  const privateKey = pemFromEnv ? pemFromEnv : fs.readFileSync(pemPath, 'utf8');

  const url = `https://${domain}${resourcePath}`;
  const signedUrl = getSignedUrl({
    url,
    keyPairId,
    privateKey,
    dateLessThan: expires.toISOString(),
  });

  return { signedUrl, expiresInSeconds: ttl, url };
}

