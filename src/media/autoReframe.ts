/**
 * Auto-Reframe System
 * Automatically fixes image orientation and computes smart crop rectangles
 * for consistent documentary-style framing.
 */

export type FramePlan = {
  rotationDeg: 0 | 90 | 180 | 270;
  crop: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  confidence: number;
  reason: string;
  anchor?: {
    x: number;
    y: number;
  };
  needsReview?: boolean;
};

export interface AutoReframeOptions {
  /** Target aspect ratio (width/height), e.g., 16/9 = 1.777 */
  targetAspect?: number;
  /** Minimum confidence threshold for auto-apply (default: 0.55) */
  confidenceThreshold?: number;
  /** Enable face detection (requires face detection library) */
  enableFaceDetection?: boolean;
  /** Headroom bias percentage for face anchors (default: 0.075 = 7.5%) */
  headroomBias?: number;
  /** Maximum dimension for scoring/resampling (default: 64 for gradient computation) */
  maxScoreDimension?: number;
}

export interface ImageMetadata {
  width: number;
  height: number;
  orientation?: number; // EXIF orientation (1-8)
  hasFaces?: boolean;
  faceCenters?: Array<{ x: number; y: number }>;
}

/**
 * Compute gradient magnitude using Sobel operator
 * @param imageData - ImageData from canvas (RGBA)
 * @param width - Image width
 * @param height - Image height
 * @returns Gradient magnitude array (size: width * height)
 */
function computeGradientMagnitude(
  imageData: ImageData,
  width: number,
  height: number
): Float32Array {
  const data = imageData.data;
  const gradient = new Float32Array(width * height);

  // Sobel kernels
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;

      // Apply Sobel kernels
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = ((y + ky) * width + (x + kx)) * 4;
          const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114; // RGB to grayscale
          const kernelIdx = (ky + 1) * 3 + (kx + 1);
          gx += gray * sobelX[kernelIdx];
          gy += gray * sobelY[kernelIdx];
        }
      }

      // Gradient magnitude
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      gradient[y * width + x] = magnitude;
    }
  }

  return gradient;
}

/**
 * Compute weighted centroid from gradient magnitude
 * @param gradient - Gradient magnitude array
 * @param width - Image width
 * @param height - Image height
 * @returns Normalized anchor point {x: 0..1, y: 0..1}
 */
function computeWeightedCentroid(
  gradient: Float32Array,
  width: number,
  height: number
): { x: number; y: number; totalWeight: number } {
  let sumX = 0;
  let sumY = 0;
  let totalWeight = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const weight = gradient[y * width + x];
      sumX += x * weight;
      sumY += y * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) {
    return { x: 0.5, y: 0.5, totalWeight: 0 };
  }

  return {
    x: sumX / totalWeight / width,
    y: sumY / totalWeight / height,
    totalWeight,
  };
}

/**
 * Create a frame plan for an image
 * @param imagePathOrBuffer - Path to image file or image buffer (or Image/HTMLImageElement/ImageBitmap)
 * @param targetAspect - Target aspect ratio (width/height)
 * @param opts - Options for reframing
 * @returns Frame plan with rotation, crop, confidence, and metadata
 */
export async function createFramePlan(
  imagePathOrBuffer: string | Buffer | HTMLImageElement | ImageBitmap,
  targetAspect: number = 16 / 9,
  opts?: AutoReframeOptions
): Promise<FramePlan> {
  const options: Required<AutoReframeOptions> = {
    targetAspect: opts?.targetAspect ?? targetAspect,
    confidenceThreshold: opts?.confidenceThreshold ?? 0.55,
    enableFaceDetection: opts?.enableFaceDetection ?? false,
    headroomBias: opts?.headroomBias ?? 0.075,
    maxScoreDimension: opts?.maxScoreDimension ?? 64,
  };

  // In browser environment, we need to load the image
  let image: HTMLImageElement | ImageBitmap;
  
  if (typeof window === 'undefined') {
    // Node.js environment - use backend implementation
    throw new Error(
      'createFramePlan: Browser implementation only. ' +
      'Use server/auto-reframe.js for Node.js backend processing.'
    );
  }

  // Handle different input types
  if (typeof imagePathOrBuffer === 'string') {
    // URL path - load image
    image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imagePathOrBuffer;
    });
  } else if (imagePathOrBuffer instanceof HTMLImageElement || imagePathOrBuffer instanceof ImageBitmap) {
    image = imagePathOrBuffer;
  } else if (imagePathOrBuffer instanceof Buffer) {
    // Buffer - convert to blob URL
    const blob = new Blob([imagePathOrBuffer]);
    const url = URL.createObjectURL(blob);
    try {
      image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    throw new Error('Unsupported image input type');
  }

  const width = image.width;
  const height = image.height;

  // Step 1: Determine rotation (assume no EXIF rotation in browser for now)
  // Browser images are typically already oriented correctly
  const rotationDeg: 0 | 90 | 180 | 270 = 0;

  // Step 2: Downscale for gradient computation
  const scale = Math.min(options.maxScoreDimension / width, options.maxScoreDimension / height);
  const scoreWidth = Math.round(width * scale);
  const scoreHeight = Math.round(height * scale);

  // Create canvas for downscaled image
  const canvas = document.createElement('canvas');
  canvas.width = scoreWidth;
  canvas.height = scoreHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  // Draw image to canvas (downscaled)
  ctx.drawImage(image, 0, 0, scoreWidth, scoreHeight);
  const imageData = ctx.getImageData(0, 0, scoreWidth, scoreHeight);

  // Step 3: Compute gradient magnitude (Sobel)
  const gradient = computeGradientMagnitude(imageData, scoreWidth, scoreHeight);

  // Step 4: Compute weighted centroid as anchor
  const centroid = computeWeightedCentroid(gradient, scoreWidth, scoreHeight);

  let anchorX = centroid.x;
  let anchorY = centroid.y;
  let confidence = 0.5;
  let reason = 'gradient centroid';

  // Apply headroom bias for faces/people style (shift anchor up)
  if (options.headroomBias > 0) {
    anchorY = Math.max(0, anchorY - options.headroomBias);
    reason += ` (headroom bias ${(options.headroomBias * 100).toFixed(1)}%)`;
  }

  // Confidence based on gradient strength
  const avgGradient = centroid.totalWeight / (scoreWidth * scoreHeight);
  confidence = Math.min(1.0, Math.max(0.3, avgGradient / 50)); // Normalize to reasonable range

  // Step 5: Compute crop rectangle using anchor
  const crop = computeCropRect(width, height, options.targetAspect, anchorX, anchorY, options.headroomBias);

  return {
    rotationDeg,
    crop,
    confidence,
    reason,
    anchor: {
      x: anchorX,
      y: anchorY,
    },
    needsReview: confidence < options.confidenceThreshold,
  };
}

/**
 * Apply frame plan to an image (rotate + crop)
 * @param imageBuffer - Source image buffer, HTMLImageElement, or ImageBitmap
 * @param plan - Frame plan to apply
 * @returns Processed image as data URL or blob
 */
export async function applyFramePlan(
  imageBuffer: Buffer | HTMLImageElement | ImageBitmap,
  plan: FramePlan
): Promise<string | Blob> {
  if (typeof window === 'undefined') {
    throw new Error(
      'applyFramePlan: Browser implementation only. ' +
      'Use server/auto-reframe.js for Node.js backend processing.'
    );
  }

  // Load image
  let image: HTMLImageElement | ImageBitmap;
  
  if (imageBuffer instanceof HTMLImageElement || imageBuffer instanceof ImageBitmap) {
    image = imageBuffer;
  } else if (imageBuffer instanceof Buffer) {
    // Buffer - convert to blob URL
    const blob = new Blob([imageBuffer]);
    const url = URL.createObjectURL(blob);
    try {
      image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    throw new Error('Unsupported image input type');
  }

  // Create canvas
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  // Apply rotation (if any)
  if (plan.rotationDeg !== 0) {
    // For rotation, we need to adjust canvas size and transform
    if (plan.rotationDeg === 90 || plan.rotationDeg === 270) {
      canvas.width = image.height;
      canvas.height = image.width;
    } else {
      canvas.width = image.width;
      canvas.height = image.height;
    }

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((plan.rotationDeg * Math.PI) / 180);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    ctx.restore();
  } else {
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.drawImage(image, 0, 0);
  }

  // Extract crop region
  const { crop } = plan;
  const croppedCanvas = document.createElement('canvas');
  croppedCanvas.width = crop.w;
  croppedCanvas.height = crop.h;
  const croppedCtx = croppedCanvas.getContext('2d');
  if (!croppedCtx) {
    throw new Error('Failed to get 2D context for cropped canvas');
  }

  croppedCtx.drawImage(
    canvas,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    crop.w,
    crop.h
  );

  // Return as blob (can be converted to data URL if needed)
  return new Promise<Blob>((resolve, reject) => {
    croppedCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to create blob'));
        }
      },
      'image/jpeg',
      0.94
    );
  });
}

/**
 * Calculate aspect ratio from dimensions
 */
export function calculateAspectRatio(width: number, height: number): number {
  if (height === 0) return 1;
  return width / height;
}

/**
 * Normalize EXIF orientation to rotation degrees
 * EXIF orientations: 1=0°, 3=180°, 6=90°CW, 8=90°CCW
 */
export function orientationToRotation(orientation: number): 0 | 90 | 180 | 270 {
  switch (orientation) {
    case 1:
      return 0;
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}

/**
 * Compute crop rectangle for target aspect ratio
 * @param srcWidth - Source image width
 * @param srcHeight - Source image height
 * @param targetAspect - Target aspect ratio (width/height)
 * @param anchorX - Anchor X coordinate (0-1 normalized)
 * @param anchorY - Anchor Y coordinate (0-1 normalized)
 * @param headroomBias - Headroom bias percentage (0-1)
 * @returns Crop rectangle {x, y, w, h}
 */
export function computeCropRect(
  srcWidth: number,
  srcHeight: number,
  targetAspect: number,
  anchorX: number = 0.5,
  anchorY: number = 0.5,
  headroomBias: number = 0
): { x: number; y: number; w: number; h: number } {
  const srcAspect = srcWidth / srcHeight;

  // If aspect ratios are very close, no crop needed
  if (Math.abs(srcAspect - targetAspect) <= 0.02) {
    return {
      x: 0,
      y: 0,
      w: srcWidth,
      h: srcHeight,
    };
  }

  let cropW: number;
  let cropH: number;

  if (srcAspect > targetAspect) {
    // Source is wider - crop width
    cropH = srcHeight;
    cropW = cropH * targetAspect;
  } else {
    // Source is taller - crop height
    cropW = srcWidth;
    cropH = cropW / targetAspect;
  }

  // Clamp crop dimensions to source dimensions
  cropW = Math.min(cropW, srcWidth);
  cropH = Math.min(cropH, srcHeight);

  // Calculate anchor point in pixels
  let anchorPixelX = anchorX * srcWidth;
  let anchorPixelY = anchorY * srcHeight;

  // Apply headroom bias (shift anchor up)
  if (headroomBias > 0) {
    anchorPixelY = Math.max(0, anchorPixelY - cropH * headroomBias);
  }

  // Center crop window on anchor, clamped to bounds
  let cropX = anchorPixelX - cropW / 2;
  let cropY = anchorPixelY - cropH / 2;

  // Clamp to bounds
  cropX = Math.max(0, Math.min(cropX, srcWidth - cropW));
  cropY = Math.max(0, Math.min(cropY, srcHeight - cropH));

  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    w: Math.round(cropW),
    h: Math.round(cropH),
  };
}
