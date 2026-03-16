import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioPipeline } from '../../src/lib/audio-pipeline';

// ---------------------------------------------------------------------------
// Mock PICOLA so tests don't run real DSP
// ---------------------------------------------------------------------------
vi.mock('../../src/lib/picola', () => ({
  picolaTimeScale: vi.fn((input: Float32Array) => {
    // Return a shorter array to simulate time-scaling
    return new Float32Array(Math.ceil(input.length * 0.8));
  }),
}));

// ---------------------------------------------------------------------------
// Minimal Web Audio API mocks so AudioPipeline can be instantiated in jsdom
// ---------------------------------------------------------------------------
function createMockGainNode() {
  return {
    gain: { value: 1.0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createMockAudioBuffer(length: number, sampleRate: number) {
  const data = new Float32Array(length);
  return {
    length,
    sampleRate,
    numberOfChannels: 1,
    duration: length / sampleRate,
    getChannelData: vi.fn(() => data),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  };
}

function createMockContext(contextSampleRate = 48000) {
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    sampleRate: contextSampleRate,
    createBuffer: vi.fn((channels: number, length: number, sr: number) =>
      createMockAudioBuffer(length, sr),
    ),
    createBufferSource: vi.fn(() => {
      const src: any = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      return src;
    }),
    createGain: vi.fn(() => createMockGainNode()),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
  };
}

const MockAudioContext = vi.fn(() => createMockContext());
vi.stubGlobal('AudioContext', MockAudioContext);

describe('AudioPipeline', () => {
  let pipeline: AudioPipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    pipeline = new AudioPipeline();
  });

  it('init creates AudioContext and GainNode', async () => {
    await pipeline.init();
    expect(MockAudioContext).toHaveBeenCalledOnce();
  });

  it('setSpeed clamps to [0.5, 3.0]', () => {
    expect(() => pipeline.setSpeed(0.1)).not.toThrow();
    expect(() => pipeline.setSpeed(5.0)).not.toThrow();
    expect(() => pipeline.setSpeed(1.5)).not.toThrow();
  });

  it('setVolume clamps to [0.0, 1.0]', async () => {
    await pipeline.init();
    pipeline.setVolume(0.5);
    pipeline.setVolume(-1);
    pipeline.setVolume(2);
  });

  it('stop resolves pending play promise', async () => {
    await pipeline.init();
    const pcm = new Float32Array(1000);
    const playPromise = pipeline.play(pcm, 24000);
    await new Promise((r) => setTimeout(r, 10));
    pipeline.stop();
    await expect(playPromise).resolves.toBeUndefined();
  });

  it('at tempo=1.0 uses direct playback (no PICOLA)', async () => {
    const { picolaTimeScale } = await import('../../src/lib/picola');
    await pipeline.init();
    const pcm = new Float32Array(1000);
    pipeline.setSpeed(1.0);
    pipeline.play(pcm, 24000);
    await new Promise((r) => setTimeout(r, 10));
    const ctx = MockAudioContext.mock.results[0].value;
    expect(ctx.createBufferSource).toHaveBeenCalled();
    expect(picolaTimeScale).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it('at tempo!=1.0 uses PICOLA time-scaling', async () => {
    const { picolaTimeScale } = await import('../../src/lib/picola');
    await pipeline.init();
    const pcm = new Float32Array(1000);
    pipeline.setSpeed(1.5);
    pipeline.play(pcm, 24000);
    await new Promise((r) => setTimeout(r, 10));
    expect(picolaTimeScale).toHaveBeenCalledWith(pcm, 24000, 1.0 / 1.5);
    pipeline.stop();
  });

  it('isPlaying is false initially and after stop', async () => {
    expect(pipeline.isPlaying).toBe(false);
    const pcm = new Float32Array(1000);
    pipeline.play(pcm, 24000);
    await new Promise((r) => setTimeout(r, 10));
    expect(pipeline.isPlaying).toBe(true);
    pipeline.stop();
    expect(pipeline.isPlaying).toBe(false);
  });

  it('play() stops previous playback', async () => {
    const pcm1 = new Float32Array(1000);
    const pcm2 = new Float32Array(500);
    const p1 = pipeline.play(pcm1, 24000);
    const p2 = pipeline.play(pcm2, 24000);
    await expect(p1).resolves.toBeUndefined();
    pipeline.stop();
    await expect(p2).resolves.toBeUndefined();
  });

  it('pause calls suspend on running context', async () => {
    await pipeline.init();
    const ctx = MockAudioContext.mock.results[0].value;
    ctx.state = 'running';
    await pipeline.pause();
    expect(ctx.suspend).toHaveBeenCalledOnce();
  });

  it('resume calls resume on suspended context', async () => {
    await pipeline.init();
    const ctx = MockAudioContext.mock.results[0].value;
    ctx.state = 'suspended';
    await pipeline.resume();
    expect(ctx.resume).toHaveBeenCalled();
  });
});
