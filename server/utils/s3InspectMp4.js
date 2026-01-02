import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from "buffer";

export async function inspectUploadedMp4({ bucket, key, s3, ffprobePath, enableFfprobe = false }) {
  try {
    const client = s3 || new S3Client({});
    const headRes = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const contentType = headRes.ContentType || '';
    const contentLength = headRes.ContentLength || 0;
    const acceptRanges = headRes.AcceptRanges === 'bytes' ? 'bytes' : null;

    const previewBytes = 2048;
    const rangeRes = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${previewBytes - 1}` })
    );
    const chunks = [];
    for await (const chunk of rangeRes.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.concat(chunks).length >= previewBytes) break;
    }
    const bodyBuf = Buffer.concat(chunks);
    const headTextPreview = bodyBuf.toString('latin1', 0, Math.min(200, bodyBuf.length));
    const hasFtyp = bodyBuf.includes(Buffer.from('ftyp'));

    const result = {
      ok: hasFtyp && contentType.includes('video/mp4'),
      contentType,
      contentLength,
      acceptRanges,
      hasFtyp,
      headTextPreview,
      ffprobeDetails: null,
    };
    console.log('[S3][INSPECT]', { key, ...result });
    return result;
  } catch (error) {
    console.error('[S3][INSPECT] Failed to inspect S3 object:', key, error.message);
    return {
      ok: false,
      contentType: 'error',
      contentLength: 0,
      acceptRanges: null,
      hasFtyp: false,
      headTextPreview: error.message.slice(0, 200),
      ffprobeDetails: null,
    };
  }
}
