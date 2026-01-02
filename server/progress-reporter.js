/**
 * Progress Reporter Utility
 * Handles progress reporting for video generation pipeline
 */

/**
 * Progress reporter class for SSE streams
 */
export class ProgressReporter {
  constructor(res) {
    this.res = res;
    this.currentPercent = 0;
    this.currentStep = '';
    this.currentDetail = '';
  }

  /**
   * Report progress
   * @param {string} step - Current step name
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} detail - Detailed status message
   */
  report(step, percent, detail = '') {
    this.currentStep = step;
    this.currentPercent = Math.max(0, Math.min(100, percent));
    this.currentDetail = detail;

    const data = {
      step,
      percent: this.currentPercent,
      detail
    };

    // Send SSE event
    this.res.write(`event: progress\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    // Also log for debugging
    console.log(`[PROGRESS] ${step}: ${this.currentPercent.toFixed(1)}% - ${detail}`);
  }

  /**
   * Report error
   * @param {Error|string} error - Error object or message
   * @param {string} step - Step where error occurred
   * @param {Object} extra - Extra error data to include
   */
  error(error, step = '', extra = null) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const data = {
      step: 'error',
      percent: this.currentPercent,
      error: errorMessage,
      detail: step || this.currentStep,
      ...(extra || {})
    };

    this.res.write(`event: error\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    console.error(`[PROGRESS] ERROR at ${step || this.currentStep}:`, error);
  }

  /**
   * Report completion
   * @param {Object} result - Final result data
   */
  complete(result) {
    const data = {
      step: 'complete',
      percent: 100,
      ...result
    };

    this.res.write(`event: complete\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    this.res.end();
  }

  /**
   * Send initial SSE headers
   */
  start() {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Send initial connection message
    this.res.write(`event: connected\n`);
    this.res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);
  }
}

/**
 * Progress weight ranges for pipeline stages
 */
export const PROGRESS_WEIGHTS = {
  VALIDATE_UPLOAD: { start: 0, end: 5 },
  ANALYZE_IMAGES: { start: 5, end: 55 },
  SEQUENCE_PLANNING: { start: 55, end: 70 },
  MOTION_PLANNING: { start: 70, end: 72 },
  RENDER_SEGMENTS: { start: 72, end: 90 },
  FFMPEG_ENCODE: { start: 90, end: 98 },
  FINALIZE: { start: 98, end: 100 }
};

/**
 * Calculate progress percentage within a weight range
 * @param {Object} weightRange - {start, end} percentage range
 * @param {number} progress - Progress within range (0-1)
 * @returns {number} Overall progress percentage
 */
export function calculateProgress(weightRange, progress) {
  const range = weightRange.end - weightRange.start;
  return weightRange.start + (range * Math.max(0, Math.min(1, progress)));
}











