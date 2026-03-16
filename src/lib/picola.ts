/**
 * PICOLA -- Pointer Interval Controlled OverLap and Add
 *
 * Time-domain speech time-scale modification. This implementation closely
 * follows the sonic library by Bill Cox (Apache 2.0), which uses PICOLA
 * for speeds between 0.5x and 2.0x, and an extended overlap method outside
 * that range.
 *
 * The algorithm works at the pitch-period level:
 *  - To speed up, it removes one pitch period at a time using overlap-add
 *    to smooth the splice, then copies unmodified samples to track a time
 *    error budget (PICOLA phase).
 *  - To slow down, it duplicates one pitch period using the same overlap-add,
 *    again correcting with unmodified copies.
 *
 * File layout:
 *  1. AMDF pitch detection    -- findPitchPeriod()
 *  2. Overlap-add crossfade   -- overlapAdd()
 *  3. Skip / insert helpers   -- skipPitchPeriod(), insertPitchPeriod()
 *  4. Main time-scale loop    -- picolaTimeScale()
 *
 * Reference: https://github.com/waywardgeek/sonic
 * Reference: https://web.archive.org/web/20120731100136/http://keizai.yokkaichi-u.ac.jp/~ikeda/research/picola.html
 */

// ---------------------------------------------------------------------------
// 1. AMDF pitch detection
// ---------------------------------------------------------------------------

const MIN_F0 = 65;   // Hz -- lowest expected fundamental (sonic's SONIC_MIN_PITCH)
const MAX_F0 = 400;  // Hz -- highest expected fundamental (sonic's SONIC_MAX_PITCH)

/**
 * Estimate the pitch period (in samples) at a given offset using Average
 * Magnitude Difference Function (AMDF).
 *
 * For each candidate period p in [minPeriod, maxPeriod], AMDF sums the
 * absolute differences between buf[offset..offset+p] and buf[offset+p..offset+2p].
 * The candidate with the smallest *normalized* difference wins.
 *
 * Normalization: `diff * bestPeriod < minDiff * period` avoids bias toward
 * shorter periods (which naturally have smaller absolute sums because the
 * summation window is shorter). This is the same comparison sonic uses.
 */
function findPitchPeriod(
  buf: Float32Array,
  offset: number,
  minPeriod: number,
  maxPeriod: number,
): number {
  let bestPeriod = 0;
  let minDiff = 1;

  for (let period = minPeriod; period <= maxPeriod; period++) {
    if (offset + period * 2 > buf.length) break;

    let diff = 0;
    for (let j = 0; j < period; j++) {
      diff += Math.abs(buf[offset + j] - buf[offset + period + j]);
    }

    // First candidate always accepted; then normalized comparison
    if (bestPeriod === 0 || diff * bestPeriod < minDiff * period) {
      minDiff = diff;
      bestPeriod = period;
    }
  }
  return bestPeriod || minPeriod;
}

// ---------------------------------------------------------------------------
// 2. Overlap-add crossfade
// ---------------------------------------------------------------------------

/**
 * Power-complementary overlap-add using sin/cos crossfade.
 *
 * Weights (sonic's SONIC_USE_SIN mode):
 *   rampUp  = sin(t * pi / (2*len))   -- fades in from 0 to 1
 *   rampDown = cos(t * pi / (2*len))  -- fades out from 1 to 0
 *
 * sin^2 + cos^2 = 1, so total energy is constant at every sample.
 * This prevents the amplitude dip you get with a linear crossfade.
 */
function overlapAdd(
  out: Float32Array,
  outOff: number,
  rampDown: Float32Array,
  rdOff: number,
  rampUp: Float32Array,
  ruOff: number,
  len: number,
): void {
  if (len <= 0) return;
  const scale = Math.PI / (2 * len);
  for (let t = 0; t < len; t++) {
    const angle = t * scale;
    const ratioUp = Math.sin(angle);
    const ratioDown = Math.cos(angle);
    out[outOff + t] = rampDown[rdOff + t] * ratioDown + rampUp[ruOff + t] * ratioUp;
  }
}

// ---------------------------------------------------------------------------
// 3. Skip / insert pitch period operations
// ---------------------------------------------------------------------------

/**
 * Skip a pitch period (speed up / compression).
 *
 * Removes one pitch period from the input by overlap-adding the current
 * region (fading out) with the region one period ahead (fading in).
 * The crossfade length equals the period itself for speed < 2.0.
 * For speed >= 2.0, overlap is shorter: period/(speed-1), matching sonic's
 * approach to avoid removing more than one period per operation.
 *
 * Returns the number of output samples written.
 */
function skipPitchPeriod(
  input: Float32Array,
  inPos: number,
  output: Float32Array,
  outPos: number,
  speed: number,
  period: number,
): number {
  const newSamples = speed >= 2.0
    ? Math.max(1, Math.round(period / (speed - 1.0)))
    : period;

  if (inPos + period + newSamples > input.length) return 0;
  if (outPos + newSamples > output.length) return 0;

  overlapAdd(
    output, outPos,
    input, inPos,            // rampDown: current (fading out)
    input, inPos + period,   // rampUp: future (fading in)
    newSamples,
  );
  return newSamples;
}

/**
 * Insert a pitch period (slow down / expansion).
 *
 * Duplicates one pitch period:
 *  1. Copy the current period to output verbatim.
 *  2. Overlap-add: blend the next period (fading out) with the current
 *     period again (fading in), producing a smooth repeated section.
 *
 * For speed <= 0.5, overlap is shorter: period*speed/(1-speed).
 * Returns { written: total output samples, consumed: input samples used }.
 */
function insertPitchPeriod(
  input: Float32Array,
  inPos: number,
  output: Float32Array,
  outPos: number,
  speed: number,
  period: number,
): { written: number; consumed: number } {
  const newSamples = speed <= 0.5
    ? Math.max(1, Math.round(period * speed / (1.0 - speed)))
    : period;

  if (inPos + period + newSamples > input.length) return { written: 0, consumed: 0 };
  if (outPos + period + newSamples > output.length) return { written: 0, consumed: 0 };

  // 1. Copy one period directly
  output.set(input.subarray(inPos, inPos + period), outPos);

  // 2. OLA: rampDown=next period, rampUp=current period (repeating it)
  overlapAdd(
    output, outPos + period,
    input, inPos + period,  // rampDown: next period (fading out)
    input, inPos,           // rampUp: current period (fading in, repeat)
    newSamples,
  );
  return { written: period + newSamples, consumed: newSamples };
}

// ---------------------------------------------------------------------------
// 4. Main time-scale loop
// ---------------------------------------------------------------------------

/**
 * Time-scale mono audio using the PICOLA algorithm.
 *
 * The main loop alternates between two phases controlled by a time-error
 * accumulator (measured in seconds):
 *
 *   Phase A (time error favorable): copy unmodified input samples straight
 *   to output. This preserves quality in regions where no splicing is needed
 *   and lets the time error drift back toward zero.
 *
 *   Phase B (time error unfavorable): detect the local pitch period with
 *   AMDF, then skip (speed up) or insert (slow down) one period using
 *   overlap-add. Update the time error to reflect the duration change.
 *
 * "Speed" follows sonic's convention: speed > 1 = faster playback.
 * The public parameter `rate` is the inverse: rate > 1 = longer output.
 *
 * @param input  Mono Float32Array of PCM samples
 * @param sr     Sample rate in Hz
 * @param rate   Duration ratio: >1 = expand (slower), <1 = compress (faster)
 * @returns      New Float32Array with time-scaled audio at the same sample rate
 */
export function picolaTimeScale(
  input: Float32Array,
  sr: number,
  rate: number,
): Float32Array {
  if (rate >= 0.99 && rate <= 1.01) {
    return new Float32Array(input);
  }

  // Convert from duration ratio to sonic's speed convention (inverse).
  const speed = 1.0 / rate;

  // Pitch period search range in samples, derived from the F0 limits.
  const minPeriod = Math.max(2, Math.floor(sr / MAX_F0));
  const maxPeriod = Math.min(Math.floor(sr / MIN_F0), Math.floor(input.length / 4));

  // Fallback for very short inputs where pitch detection is impossible:
  // use simple sample-dropping/repeating (nearest-neighbor resample).
  if (maxPeriod <= minPeriod || input.length < maxPeriod * 2) {
    const outLen = Math.max(1, Math.round(input.length * rate));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = input[Math.min(Math.floor(i / rate), input.length - 1)];
    }
    return out;
  }

  const maxRequired = 2 * maxPeriod;
  const maxOutLen = Math.ceil(input.length * rate * 1.2) + maxRequired;
  const output = new Float32Array(maxOutLen);

  // Time error accumulator (seconds). Positive = output is ahead of where
  // it should be, negative = output is behind. The PICOLA phases (copy vs
  // skip/insert) are chosen to push this toward zero.
  const samplePeriod = 1.0 / sr;
  let timeError = 0.0;
  let inPos = 0;
  let outPos = 0;

  while (inPos + maxRequired < input.length) {
    if (speed > 1.0) {
      // --- SPEED UP (compression): remove pitch periods ---
      if (speed < 2.0 && timeError < 0.0) {
        // Phase A: output is behind schedule. Copy unmodified samples so
        // the output catches up. The number of samples to copy comes from
        // sonic's copyUnmodifiedSamples formula.
        const copyFloat = 1 - timeError * speed / (samplePeriod * (speed - 1.0));
        const available = input.length - inPos - maxRequired;
        const copyLen = Math.min(
          Math.max(1, Math.round(copyFloat)),
          available,
          output.length - outPos,
        );
        if (copyLen <= 0) break;

        output.set(input.subarray(inPos, inPos + copyLen), outPos);
        outPos += copyLen;
        inPos += copyLen;
        timeError += copyLen * samplePeriod * (speed - 1.0) / speed;
      } else {
        // Phase B: skip one pitch period to shorten the output.
        const period = findPitchPeriod(input, inPos, minPeriod, maxPeriod);
        const newSamples = skipPitchPeriod(input, inPos, output, outPos, speed, period);
        if (newSamples === 0) break;

        outPos += newSamples;
        inPos += period + newSamples;

        if (speed < 2.0) {
          // Update time error: output gained newSamples of duration but
          // consumed (period + newSamples) of input time.
          timeError += newSamples * samplePeriod -
            (period + newSamples) * samplePeriod / speed;
        }
      }
    } else {
      // --- SLOW DOWN (expansion): insert pitch periods ---
      if (speed > 0.5 && timeError > 0.0) {
        // Phase A: output is ahead of schedule. Copy unmodified samples
        // to let the time error drift back toward zero.
        const copyFloat = timeError * speed / (samplePeriod * (1.0 - speed));
        const available = input.length - inPos - maxRequired;
        const copyLen = Math.min(
          Math.max(1, Math.round(copyFloat)),
          available,
          output.length - outPos,
        );
        if (copyLen <= 0) break;

        output.set(input.subarray(inPos, inPos + copyLen), outPos);
        outPos += copyLen;
        inPos += copyLen;
        // (speed-1) is negative → timeError decreases
        timeError += copyLen * samplePeriod * (speed - 1.0) / speed;
      } else {
        // Phase B: insert one pitch period to lengthen the output.
        const period = findPitchPeriod(input, inPos, minPeriod, maxPeriod);
        const { written, consumed } = insertPitchPeriod(
          input, inPos, output, outPos, speed, period,
        );
        if (written === 0) break;

        outPos += written;
        inPos += consumed;

        if (speed > 0.5) {
          // Update time error: output grew by `written` samples but only
          // consumed `consumed` input samples worth of real time.
          timeError += written * samplePeriod -
            consumed * samplePeriod / speed;
        }
      }
    }
  }

  // Copy remaining input
  const remaining = Math.min(input.length - inPos, output.length - outPos);
  if (remaining > 0) {
    output.set(input.subarray(inPos, inPos + remaining), outPos);
    outPos += remaining;
  }

  return output.subarray(0, outPos);
}
