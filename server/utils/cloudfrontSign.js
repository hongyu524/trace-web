export function signCloudFrontUrl(key) {
  // Placeholder implementation; real signing handled in cloudfront-signer.js
  return buildCloudFrontUrl(key);
}

export function buildCloudFrontUrl(path) {
  const domain = process.env.CLOUDFRONT_DOMAIN;
  if (!domain) return null;
  const cleaned = path.startsWith('/') ? path : `/${path}`;
  return `https://${domain}${cleaned}`;
}
