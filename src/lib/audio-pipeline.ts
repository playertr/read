import { picolaTimeScale } from './picola';

/**
 * Audio playback pipeline: plays TTS-generated PCM through the Web Audio API
 * with pitch-preserving speed control via PICOLA.
 *
 * Audio chain:
 *   tempo = 1.0  -> AudioBufferSourceNode -> GainNode -> destination  (direct, no processing)
 *   tempo != 1.0 -> PICOLA time-scale -> AudioBufferSourceNode -> GainNode -> destination
 *
 * At non-unity speeds the entire buffer is pre-processed by picolaTimeScale()
 * into a new Float32Array at the original sample rate but with modified
 * duration, then played through a standard AudioBufferSourceNode. This keeps
 * the audio graph simple (no ScriptProcessorNode or AudioWorklet needed).
 */
export class AudioPipeline {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  private directSource: AudioBufferSourceNode | null = null;

  private _isPlaying = false;
  private playbackResolve: (() => void) | null = null;
  private endedFired = false;

  // Stored for mid-playback speed switching
  private currentPcm: Float32Array | null = null;
  private currentSampleRate = 0;
  private directStartTime = 0;

  private _tempo = 1.0;
  private _volume = 1.0;

  /** Callback fired when the current buffer finishes playing. */
  onEnded: (() => void) | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Create AudioContext if it doesn't exist yet and resume it. */
  async init(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this._volume;
      this.gainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Play PCM audio data through the pipeline.
   * Stops any currently-playing audio first.
   * Resolves when playback finishes naturally or is stopped.
   */
  async play(pcm: Float32Array, sampleRate: number): Promise<void> {
    await this.init();

    // Stop previous playback (resolves its promise immediately)
    this.stopInternal();

    this.currentPcm = pcm;
    this.currentSampleRate = sampleRate;

    return new Promise<void>((resolve) => {
      this.playbackResolve = resolve;
      this.endedFired = false;
      this.startPlayback(pcm, sampleRate, 0);
    });
  }

  /** Suspend the AudioContext (pauses all audio output). */
  async pause(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      await this.ctx.suspend();
    }
  }

  /** Resume a suspended AudioContext. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /** Stop current playback and disconnect all sources. */
  stop(): void {
    this.stopInternal();
  }

  /**
   * Set playback speed (clamped to 0.5–3.0).
   * At exactly 1.0, plays directly (zero processing).
   * Otherwise uses PICOLA for pitch-preserving time-scale modification.
   */
  setSpeed(tempo: number): void {
    const newTempo = clamp(tempo, 0.5, 3.0);
    const oldTempo = this._tempo;
    this._tempo = newTempo;

    if (!this._isPlaying || !this.currentPcm) return;

    // If speed changed, restart playback with PICOLA re-processing
    if (oldTempo !== newTempo) {
      const offset = this.getPlaybackOffset();
      this.cleanupSources();
      this.startPlayback(this.currentPcm, this.currentSampleRate, offset);
    }
  }

  /** Set output gain (clamped to 0.0–1.0). */
  setVolume(volume: number): void {
    this._volume = clamp(volume, 0, 1);
    if (this.gainNode) {
      this.gainNode.gain.value = this._volume;
    }
  }

  /** Whether audio is currently being played (true even while paused/suspended). */
  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Get playback progress as a fraction (0.0–1.0) of the current buffer. */
  getProgress(): number {
    if (!this._isPlaying || !this.currentPcm || this.currentPcm.length === 0) return 0;
    const offset = this.getPlaybackOffset();
    // Account for PICOLA scaling: offset is in scaled-buffer samples,
    // but we want progress through the original audio
    if (this._tempo === 1.0) {
      return Math.min(1.0, offset / this.currentPcm.length);
    } else {
      // Scaled buffer is shorter/longer by 1/tempo factor
      const scaledLen = Math.round(this.currentPcm.length / this._tempo);
      return Math.min(1.0, offset / Math.max(1, scaledLen));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Estimate current playback position in samples. */
  private getPlaybackOffset(): number {
    if (this.directSource && this.ctx) {
      const elapsed = this.ctx.currentTime - this.directStartTime;
      return Math.floor(elapsed * this.currentSampleRate);
    }
    return 0;
  }

  /**
   * Begin playback of `pcm` starting at `offsetSamples`.
   * Uses direct AudioBufferSourceNode at 1.0× (lets browser handle resampling).
   * Uses PICOLA time-scaling at other speeds.
   */
  private startPlayback(
    pcm: Float32Array,
    sampleRate: number,
    offsetSamples: number
  ): void {
    const ctx = this.ctx!;
    const data = offsetSamples > 0 ? pcm.subarray(offsetSamples) : pcm;

    if (data.length === 0) {
      this.handleEnded();
      return;
    }

    if (this._tempo === 1.0) {
      // Direct path: AudioBufferSourceNode handles sample rate conversion
      const audioBuffer = ctx.createBuffer(1, data.length, sampleRate);
      audioBuffer.getChannelData(0).set(data);
      this.startDirect(audioBuffer);
    } else {
      // PICOLA path: time-scale the audio, then play directly
      // rate = 1/tempo: tempo > 1 = faster = compress = rate < 1
      const scaled = picolaTimeScale(data, sampleRate, 1.0 / this._tempo);
      const audioBuffer = ctx.createBuffer(1, scaled.length, sampleRate);
      audioBuffer.getChannelData(0).set(scaled);
      this.startDirect(audioBuffer);
    }
  }

  /** Direct playback path — minimal latency, browser handles resampling. */
  private startDirect(audioBuffer: AudioBuffer): void {
    const source = this.ctx!.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode!);
    source.onended = () => this.handleEnded();

    this.directSource = source;
    this.directStartTime = this.ctx!.currentTime;
    this._isPlaying = true;
    source.start();
  }

  /**
   * Called when a buffer finishes playing.
   * Guarded against duplicate invocations.
   */
  private handleEnded(): void {
    if (this.endedFired) return;
    this.endedFired = true;

    this.cleanupSources();
    this._isPlaying = false;
    this.currentPcm = null;

    const resolve = this.playbackResolve;
    this.playbackResolve = null;

    this.onEnded?.();
    resolve?.();
  }

  /** Disconnect and release all active audio sources. */
  private cleanupSources(): void {
    if (this.directSource) {
      try {
        this.directSource.onended = null;
        this.directSource.stop();
        this.directSource.disconnect();
      } catch {
        /* already stopped */
      }
      this.directSource = null;
    }
  }

  /** Stop playback, resolve pending promise, but do NOT fire `onEnded`. */
  private stopInternal(): void {
    this.cleanupSources();
    this._isPlaying = false;
    this.currentPcm = null;
    this.endedFired = true; // Prevent stale callbacks from firing later.

    const resolve = this.playbackResolve;
    this.playbackResolve = null;
    resolve?.();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
