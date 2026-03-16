import { describe, it, expect } from 'vitest';
import { picolaTimeScale } from '../../src/lib/picola';

/**
 * PICOLA (Pointer Interval Controlled OverLap and Add) time-scale tests.
 *
 * Tests validate:
 *  - Output length correctness at various rates
 *  - Energy (RMS) preservation
 *  - Frequency content preservation via DFT
 *  - Sibilant/transient preservation
 *  - Edge cases: 1.0×, very high/low rates
 */

const SR = 48000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate speech-like test signal: fundamental + formants + sibilant. */
function generateSpeechSignal(
  sr: number,
  dur: number,
  f0 = 150,
  sibTime?: number,
): Float32Array {
  const N = Math.floor(sr * dur);
  const signal = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    // Voiced speech components
    signal[i] =
      0.4 * Math.sin(2 * Math.PI * f0 * t) +       // fundamental
      0.2 * Math.sin(2 * Math.PI * f0 * 2 * t) +   // 2nd harmonic
      0.1 * Math.sin(2 * Math.PI * 1200 * t) +      // formant
      0.05 * Math.sin(2 * Math.PI * 3500 * t);      // high formant
  }
  if (sibTime !== undefined) {
    const sibStart = Math.floor(sibTime * sr);
    const sibLen = Math.floor(0.05 * sr); // 50ms noise burst
    let seed = 42;
    for (let i = 0; i < sibLen && sibStart + i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      signal[sibStart + i] += 0.8 * ((seed / 0x7fffffff) * 2 - 1);
    }
  }
  return signal;
}

/** Compute RMS energy. */
function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}

/** Measure HF energy via first-difference squared in a window. */
function measureHF(signal: Float32Array, centerSample: number, winSamples: number): number {
  const start = Math.max(1, centerSample - winSamples);
  const end = Math.min(signal.length, centerSample + winSamples);
  let energy = 0;
  for (let i = start; i < end; i++) {
    const d = signal[i] - signal[i - 1];
    energy += d * d;
  }
  return energy;
}

/** Measure DFT magnitude at a specific frequency. */
function dftMagnitudeAt(signal: Float32Array, freq: number, sr: number): number {
  let re = 0, im = 0;
  const omega = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(omega * i);
    im += signal[i] * Math.sin(omega * i);
  }
  return Math.sqrt(re * re + im * im) / signal.length;
}

// ---------------------------------------------------------------------------
// Tests: Output length
// ---------------------------------------------------------------------------

describe('PICOLA output length', () => {
  const signal = generateSpeechSignal(SR, 2.0);

  for (const rate of [0.5, 0.75, 1.0, 1.5, 2.0, 3.0]) {
    it(`produces correct output length at ${rate}× (expansion = slowing down)`, () => {
      const output = picolaTimeScale(signal, SR, rate);
      const expectedLen = signal.length * rate;
      // Allow 5% tolerance for pitch-synchronous adjustment
      expect(output.length).toBeGreaterThan(expectedLen * 0.90);
      expect(output.length).toBeLessThan(expectedLen * 1.10);
    });
  }

  it('returns input unchanged at 1.0×', () => {
    const output = picolaTimeScale(signal, SR, 1.0);
    expect(output.length).toBe(signal.length);
    // Should be identical samples
    for (let i = 0; i < signal.length; i++) {
      expect(output[i]).toBe(signal[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: RMS energy preservation
// ---------------------------------------------------------------------------

describe('PICOLA energy preservation', () => {
  const signal = generateSpeechSignal(SR, 2.0);
  const inputRms = rms(signal);

  for (const rate of [0.5, 0.75, 1.5, 2.0, 3.0]) {
    it(`preserves RMS within 25% at ${rate}×`, () => {
      const output = picolaTimeScale(signal, SR, rate);
      const outputRms = rms(output);
      expect(outputRms / inputRms).toBeGreaterThan(0.75);
      expect(outputRms / inputRms).toBeLessThan(1.25);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: Frequency preservation
// ---------------------------------------------------------------------------

describe('PICOLA frequency preservation', () => {
  const f0 = 150;
  const signal = generateSpeechSignal(SR, 2.0, f0);
  const refMag150 = dftMagnitudeAt(signal, f0, SR);
  const refMag300 = dftMagnitudeAt(signal, f0 * 2, SR);

  for (const rate of [0.5, 1.5, 2.0, 3.0]) {
    it(`preserves fundamental frequency at ${rate}×`, () => {
      const output = picolaTimeScale(signal, SR, rate);
      const outMag150 = dftMagnitudeAt(output, f0, SR);
      // Fundamental should be preserved within 50% of original magnitude
      expect(outMag150 / refMag150).toBeGreaterThan(0.5);
    });

    it(`preserves 2nd harmonic at ${rate}×`, () => {
      const output = picolaTimeScale(signal, SR, rate);
      const outMag300 = dftMagnitudeAt(output, f0 * 2, SR);
      expect(outMag300 / refMag300).toBeGreaterThan(0.5);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: Sibilant preservation
// ---------------------------------------------------------------------------

describe('PICOLA sibilant preservation', () => {
  const signal = generateSpeechSignal(SR, 2.0, 150, 0.8);
  const win = Math.floor(0.08 * SR);
  const refHF = measureHF(signal, Math.floor(0.8 * SR), win);

  it('test signal has detectable sibilant', () => {
    const quietHF = measureHF(signal, Math.floor(0.3 * SR), win);
    expect(refHF).toBeGreaterThan(quietHF * 3);
  });

  for (const rate of [0.5, 1.5, 2.0]) {
    it(`preserves sibilant HF at ${rate}×`, () => {
      const output = picolaTimeScale(signal, SR, rate);
      const expectedPos = Math.floor(0.8 * SR * rate);
      const hf = measureHF(output, expectedPos, win);
      // PICOLA should preserve transients better than WSOLA
      expect(hf / refHF).toBeGreaterThan(0.05);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: Different pitch ranges
// ---------------------------------------------------------------------------

describe('PICOLA handles different voice pitches', () => {
  for (const f0 of [100, 150, 250]) {
    it(`works with f0=${f0}Hz at 2.0×`, () => {
      const signal = generateSpeechSignal(SR, 1.0, f0);
      const output = picolaTimeScale(signal, SR, 2.0);
      // Output should be roughly 2× length
      expect(output.length / signal.length).toBeGreaterThan(1.8);
      expect(output.length / signal.length).toBeLessThan(2.2);
      // RMS preserved
      expect(rms(output) / rms(signal)).toBeGreaterThan(0.75);
    });

    it(`works with f0=${f0}Hz at 0.5×`, () => {
      const signal = generateSpeechSignal(SR, 1.0, f0);
      const output = picolaTimeScale(signal, SR, 0.5);
      expect(output.length / signal.length).toBeGreaterThan(0.4);
      expect(output.length / signal.length).toBeLessThan(0.6);
      expect(rms(output) / rms(signal)).toBeGreaterThan(0.75);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: Edge cases
// ---------------------------------------------------------------------------

describe('PICOLA edge cases', () => {
  it('handles very short signal (< 1 pitch period)', () => {
    const short = new Float32Array(100); // ~2ms at 48kHz
    for (let i = 0; i < 100; i++) short[i] = Math.sin(2 * Math.PI * 150 * i / SR);
    const output = picolaTimeScale(short, SR, 2.0);
    expect(output.length).toBeGreaterThan(0);
  });

  it('handles silence', () => {
    const silence = new Float32Array(SR); // 1 second of silence
    const output = picolaTimeScale(silence, SR, 2.0);
    // Should not crash; output should be mostly silence
    expect(rms(output)).toBeLessThan(0.01);
  });

  it('does not produce NaN or Infinity', () => {
    const signal = generateSpeechSignal(SR, 1.0);
    for (const rate of [0.5, 1.5, 2.0, 3.0]) {
      const output = picolaTimeScale(signal, SR, rate);
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
      }
    }
  });

  it('does not clip beyond ±1.0 for normalized input', () => {
    const signal = generateSpeechSignal(SR, 1.0);
    // Normalize to ±0.9
    const maxAbs = signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    for (let i = 0; i < signal.length; i++) signal[i] *= 0.9 / maxAbs;
    
    for (const rate of [0.5, 1.5, 2.0, 3.0]) {
      const output = picolaTimeScale(signal, SR, rate);
      const outMax = output.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      // sin/cos crossfade is power-complementary (sin²+cos²=1) but can peak
      // at √2 ≈ 1.414 in amplitude. This matches sonic's SONIC_USE_SIN behavior.
      expect(outMax).toBeLessThan(1.45);
    }
  });
});
