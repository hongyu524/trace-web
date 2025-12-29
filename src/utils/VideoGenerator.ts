interface ImageData {
  img: HTMLImageElement;
  duration: number;
  effect: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'static';
}

export default class VideoGenerator {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 1920;
  private height = 1080;
  private fps = 30;
  private defaultMusicCandidates = [
    '/assets/music_pack/ACOUSTIC-GUIT-AR-EMOTIONAL-NOSTALGIA.mp3',
    '/assets/music_pack/golden-waves.mp3',
    '/assets/music_pack/Affection_full-length.mp3',
    '/assets/music_pack/Inspirations-Cinematic-Felt-Piano.mp3',
    '/assets/music_pack/Nature.mp3',
    '/assets/music_pack/PROPOSA.mp3'
  ];

  private secondsFromFrames(frames: number) {
    return Math.max(0, frames / this.fps);
  }

  private isNearStatic(effect: ImageData['effect']) {
    return effect === 'static';
  }

  private getZoomDir(effect: ImageData['effect']) {
    if (effect === 'zoom-in') return 'in';
    if (effect === 'zoom-out') return 'out';
    return 'static';
  }

  private getTransitionPreset(params: {
    beatPosition: number;
    fromEffect: ImageData['effect'];
    toEffect: ImageData['effect'];
  }): { type: 'hard_cut' | 'match_dissolve' | 'breath_hold' | 'dip_to_black_micro'; durationSeconds: number; holdSeconds: number } {
    const { beatPosition, fromEffect, toEffect } = params;

    const phase =
      beatPosition < 0.15 ? 'intro' :
      beatPosition < 0.70 ? 'development' :
      beatPosition < 0.90 ? 'climax' :
      'resolve';

    const fromZoom = this.getZoomDir(fromEffect);
    const toZoom = this.getZoomDir(toEffect);
    const zoomFlip = fromZoom !== 'static' && toZoom !== 'static' && fromZoom !== toZoom;
    const zoomAlign = !zoomFlip && fromZoom !== 'static' && toZoom !== 'static' && fromZoom === toZoom;
    const bothStatic = this.isNearStatic(fromEffect) && this.isNearStatic(toEffect);

    if (zoomFlip) {
      return { type: 'hard_cut', durationSeconds: 0, holdSeconds: 0 };
    }

    if (phase === 'intro') {
      if (zoomAlign) return { type: 'match_dissolve', durationSeconds: this.secondsFromFrames(6), holdSeconds: 0 };
      return { type: 'hard_cut', durationSeconds: 0, holdSeconds: 0 };
    }

    if (phase === 'development') {
      if (zoomAlign) return { type: 'match_dissolve', durationSeconds: this.secondsFromFrames(5), holdSeconds: 0 };
      return { type: 'hard_cut', durationSeconds: 0, holdSeconds: 0 };
    }

    if (phase === 'climax') {
      if (bothStatic) return { type: 'breath_hold', durationSeconds: 0, holdSeconds: this.secondsFromFrames(10) };
      return { type: 'breath_hold', durationSeconds: 0, holdSeconds: this.secondsFromFrames(8) };
    }

    if (beatPosition >= 0.94) {
      return { type: 'dip_to_black_micro', durationSeconds: this.secondsFromFrames(8), holdSeconds: 0 };
    }

    if (bothStatic) {
      return { type: 'breath_hold', durationSeconds: 0, holdSeconds: this.secondsFromFrames(12) };
    }

    return { type: 'hard_cut', durationSeconds: 0, holdSeconds: 0 };
  }

  /**
   * Try to load a background music track from known asset paths.
   * Returns an HTMLAudioElement ready to play, or null if none load.
   */
  private async loadAudioTrack(): Promise<HTMLAudioElement | null> {
    for (const candidate of this.defaultMusicCandidates) {
      try {
        const audio = new Audio(candidate);
        audio.loop = true;
        audio.crossOrigin = 'anonymous';
        await audio.play().catch(() => audio.play()); // Retry once

        // Wait for canplaythrough before returning
        await new Promise<void>((resolve, reject) => {
          const onReady = () => {
            audio.removeEventListener('canplaythrough', onReady);
            audio.removeEventListener('error', onError);
            resolve();
          };
          const onError = () => {
            audio.removeEventListener('canplaythrough', onReady);
            audio.removeEventListener('error', onError);
            reject(new Error('Audio load error'));
          };
          audio.addEventListener('canplaythrough', onReady, { once: true });
          audio.addEventListener('error', onError, { once: true });
        });

        console.log('[VIDEO] Using music track:', candidate);
        return audio;
      } catch (err) {
        console.warn('[VIDEO] Music track failed, trying next:', candidate, err);
      }
    }

    console.warn('[VIDEO] No music track could be loaded; proceeding without audio.');
    return null;
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d')!;
  }

  private async renderHold(duration: number): Promise<void> {
    const frames = Math.floor(duration * this.fps);
    for (let frame = 0; frame < frames; frame++) {
      await this.waitFrame();
    }
  }

  private async renderDipToBlack(from: ImageData, to: ImageData, duration: number): Promise<void> {
    const frames = Math.max(2, Math.floor(duration * this.fps));
    const half = Math.floor(frames / 2);

    for (let frame = 0; frame < frames; frame++) {
      const t = frame / (frames - 1);
      this.easeInOutCubic(t);

      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.width, this.height);

      if (frame < half) {
        const local = half > 1 ? frame / (half - 1) : 1;
        const a = 1 - this.easeInOutCubic(local);
        this.ctx.save();
        this.ctx.globalAlpha = a;
        this.drawImageWithEffect(from.img, from.effect, 1);
        this.ctx.restore();
      } else {
        const local = (frames - half) > 1 ? (frame - half) / (frames - half - 1) : 1;
        const a = this.easeInOutCubic(local);
        this.ctx.save();
        this.ctx.globalAlpha = a;
        this.drawImageWithEffect(to.img, to.effect, 0);
        this.ctx.restore();
      }

      await this.waitFrame();
    }
  }

  async createVideo(photos: File[], memoryText?: string): Promise<Blob> {
    const images = await this.loadImages(photos);
    const narrative = this.buildNarrative(images);
    const audio = await this.loadAudioTrack();

    return new Promise((resolve, reject) => {
      const chunks: Blob[] = [];
      const videoStream = this.canvas.captureStream(this.fps);
      const audioStream = audio && typeof (audio as any).captureStream === 'function'
        ? (audio as any).captureStream()
        : null;

      const mixedStream = audioStream
        ? new MediaStream([
            ...videoStream.getVideoTracks(),
            ...audioStream.getAudioTracks()
          ])
        : videoStream;

      const mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 5000000
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
        const blob = new Blob(chunks, { type: 'video/webm' });
        resolve(blob);
      };

      mediaRecorder.onerror = (e) => {
        reject(e);
      };

      mediaRecorder.start();
      this.renderVideo(narrative, memoryText).then(() => {
        mediaRecorder.stop();
      });
    });
  }

  private async loadImages(files: File[]): Promise<HTMLImageElement[]> {
    const loadPromises = files.map(file => {
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    });

    return Promise.all(loadPromises);
  }

  private buildNarrative(images: HTMLImageElement[]): ImageData[] {
    const narrative: ImageData[] = [];
    // Force cinematic calm: only static frames (no random movement)
    const effects: ImageData['effect'][] = ['static'];

    const structure = [
      { phase: 'arrival', count: 3, avgDuration: 4 },
      { phase: 'recognition', count: 5, avgDuration: 4 },
      { phase: 'intimacy', count: 7, avgDuration: 3.5 },
      { phase: 'pause', count: 4, avgDuration: 5 },
      { phase: 'trace', count: 3, avgDuration: 5 }
    ];

    let imageIndex = 0;
    const totalImages = Math.min(images.length, 22);
    const selectedImages = this.selectImages(images, totalImages);

    for (const section of structure) {
      for (let i = 0; i < section.count && imageIndex < selectedImages.length; i++) {
        const effect = 'static';

        const duration = section.phase === 'pause' || section.phase === 'trace'
          ? section.avgDuration + Math.random() * 2
          : section.avgDuration + (Math.random() - 0.5);

        narrative.push({
          img: selectedImages[imageIndex],
          duration,
          effect
        });

        imageIndex++;
      }
    }

    return narrative;
  }

  private selectImages(images: HTMLImageElement[], count: number): HTMLImageElement[] {
    if (images.length <= count) return images;

    const selected: HTMLImageElement[] = [];
    const step = images.length / count;

    for (let i = 0; i < count; i++) {
      const index = Math.floor(i * step);
      selected.push(images[index]);
    }

    return selected;
  }

  private async renderVideo(narrative: ImageData[], memoryText?: string): Promise<void> {
    if (memoryText) {
      await this.renderTitleCard(memoryText, 3);
    }

    for (let i = 0; i < narrative.length; i++) {
      const current = narrative[i];
      const next = narrative[i + 1];

      await this.renderImage(current);

      if (next) {
        const beatPosition = narrative.length > 1 ? i / (narrative.length - 1) : 0.5;
        const preset = this.getTransitionPreset({
          beatPosition,
          fromEffect: current.effect,
          toEffect: next.effect
        });

        console.log('[TRANSITION]');
        console.log(`type=${preset.type}`);
        console.log(`beatPosition=${beatPosition.toFixed(2)}`);

        if (preset.holdSeconds > 0) {
          await this.renderHold(preset.holdSeconds);
        }

        if (preset.type === 'hard_cut' || preset.durationSeconds <= 0) {
          continue;
        }

        if (preset.type === 'dip_to_black_micro') {
          await this.renderDipToBlack(current, next, preset.durationSeconds);
        } else {
          await this.renderTransition(current, next, preset.durationSeconds);
        }
      }
    }

    await this.renderFadeOut(1.5);
  }

  private async renderTitleCard(text: string, duration: number): Promise<void> {
    const frames = duration * this.fps;

    for (let frame = 0; frame < frames; frame++) {
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.width, this.height);

      const alpha = frame < this.fps ? frame / this.fps : frame > frames - this.fps ? (frames - frame) / this.fps : 1;

      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '48px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(text, this.width / 2, this.height / 2);
      this.ctx.restore();

      await this.waitFrame();
    }
  }

  private async renderImage(imageData: ImageData): Promise<void> {
    const frames = Math.floor(imageData.duration * this.fps);
    const img = imageData.img;

    for (let frame = 0; frame < frames; frame++) {
      const progress = frame / frames;
      this.drawImageWithEffect(img, imageData.effect, progress);
      await this.waitFrame();
    }
  }

  private drawImageWithEffect(img: HTMLImageElement, effect: ImageData['effect'], progress: number): void {
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.width, this.height);

    const imgRatio = img.width / img.height;
    const canvasRatio = this.width / this.height;

    let drawWidth = this.width;
    let drawHeight = this.height;
    let offsetX = 0;
    let offsetY = 0;

    if (imgRatio > canvasRatio) {
      drawWidth = this.height * imgRatio;
      offsetX = (this.width - drawWidth) / 2;
    } else {
      drawHeight = this.width / imgRatio;
      offsetY = (this.height - drawHeight) / 2;
    }

    this.ctx.save();

    // Disable movement to eliminate shake/jitter
    const effectAmount = 0;

    switch (effect) {
      case 'zoom-in': {
        const scale = 1 + progress * effectAmount;
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        this.ctx.translate(centerX, centerY);
        this.ctx.scale(scale, scale);
        this.ctx.translate(-centerX, -centerY);
        break;
      }
      case 'zoom-out': {
        const scale = 1.1 - progress * effectAmount;
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        this.ctx.translate(centerX, centerY);
        this.ctx.scale(scale, scale);
        this.ctx.translate(-centerX, -centerY);
        break;
      }
      case 'pan-left':
      case 'pan-right':
        // No pan when effectAmount is 0
        break;
    }

    this.ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
    this.ctx.restore();
  }

  private async renderTransition(from: ImageData, to: ImageData, duration: number): Promise<void> {
    const frames = Math.floor(duration * this.fps);

    for (let frame = 0; frame < frames; frame++) {
      const progress = frame / frames;
      const eased = this.easeInOutCubic(progress);

      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.width, this.height);

      this.ctx.save();
      this.ctx.globalAlpha = 1 - eased;
      this.drawImageWithEffect(from.img, from.effect, 1);
      this.ctx.restore();

      this.ctx.save();
      this.ctx.globalAlpha = eased;
      this.drawImageWithEffect(to.img, to.effect, 0);
      this.ctx.restore();

      await this.waitFrame();
    }
  }

  private async renderFadeOut(duration: number): Promise<void> {
    const frames = Math.floor(duration * this.fps);

    for (let frame = 0; frame < frames; frame++) {
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.width, this.height);
      await this.waitFrame();
    }
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  private waitFrame(): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, 1000 / this.fps);
    });
  }
}
