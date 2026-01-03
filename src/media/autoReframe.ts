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
  /** Maximum dimension for scoring/resampling (default: 256) */
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
 * Create a frame plan for an image
 * @param imagePathOrBuffer - Path to image file or image buffer
 * @param targetAspect - Target aspect ratio (width/height)
 * @param opts - Options for reframing
 * @returns Frame plan with rotation, crop, confidence, and metadata
 */
export async function createFramePlan(
  imagePathOrBuffer: string | Buffer,
  targetAspect: number = 16 / 9,
  opts?: AutoReframeOptions
): Promise<FramePlan> {
  const options: Required<AutoReframeOptions> = {
    targetAspect: opts?.targetAspect ?? targetAspect,
    confidenceThreshold: opts?.confidenceThreshold ?? 0.55,
    enableFaceDetection: opts?.enableFaceDetection ?? false,
    headroomBias: opts?.headroomBias ?? 0.075,
    maxScoreDimension: opts?.maxScoreDimension ?? 256,
  };

  // In TypeScript/browser version, this would use browser APIs or WebAssembly
  // For now, this is a type definition - actual implementation in backend JS version
  throw new Error(
    'createFramePlan: TypeScript implementation requires backend JS version. ' +
    'Use server/auto-reframe.js for actual processing.'
  );
}

/**
 * Apply frame plan to an image (rotate + crop)
 * @param imageBuffer - Source image buffer
 * @param plan - Frame plan to apply
 * @returns Processed image buffer
 */
export async function applyFramePlan(
  imageBuffer: Buffer,
  plan: FramePlan
): Promise<Buffer> {
  // In TypeScript/browser version, this would use browser APIs or WebAssembly
  // For now, this is a type definition - actual implementation in backend JS version
  throw new Error(
    'applyFramePlan: TypeScript implementation requires backend JS version. ' +
    'Use server/auto-reframe.js for actual processing.'
  );
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

