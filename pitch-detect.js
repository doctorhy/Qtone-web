/**
 * YIN-based pitch detection algorithm (improved).
 * Instead of taking the first dip below threshold, collects all candidate
 * local minima and picks the best one — more robust against harmonic confusion
 * that causes wrong-octave or wrong-note detection on noisy mic signals.
 *
 * Returns detected frequency in Hz, or -1 if no clear pitch found.
 */
function detectPitch(buffer, sampleRate) {
  const bufferSize = buffer.length;
  const halfSize = Math.floor(bufferSize / 2);
  const yinBuffer = new Float32Array(halfSize);

  // Frequency range limits (tau = sampleRate / freq)
  const minFreq = 60;   // ~B1
  const maxFreq = 2000;  // well above highest tuner note
  const minTau = Math.floor(sampleRate / maxFreq); // ~24 at 48kHz
  const maxTau = Math.min(Math.ceil(sampleRate / minFreq), halfSize); // ~800 at 48kHz

  // Step 1: Squared difference function
  for (let tau = 0; tau < maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < halfSize; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // Step 2: Cumulative mean normalized difference (CMNDF)
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < maxTau; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] *= tau / runningSum;
  }

  // Step 3: Collect all local minima below threshold
  const threshold = 0.20;
  const candidates = []; // { tau, value }

  for (let tau = minTau; tau < maxTau - 1; tau++) {
    if (yinBuffer[tau] < threshold) {
      // Walk to the bottom of this dip
      while (tau + 1 < maxTau && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      candidates.push({ tau: tau, value: yinBuffer[tau] });
    }
  }

  if (candidates.length === 0) return -1;

  // Step 4: Pick the best candidate.
  // Prefer the candidate with the lowest CMNDF value (strongest periodicity).
  // Among candidates with similarly low values (within 20% of the best),
  // prefer the one at the highest tau (lowest frequency = fundamental).
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.value < best.value * 0.8) {
      // Significantly better CMNDF — take it regardless
      best = c;
    } else if (c.value < best.value * 1.2 && c.tau > best.tau * 1.5) {
      // Similar CMNDF but at much higher tau (lower frequency) —
      // likely the true fundamental vs a harmonic
      best = c;
    }
  }

  const tauEstimate = best.tau;

  // Step 5: Parabolic interpolation for sub-sample precision
  const s0 = tauEstimate > 0 ? yinBuffer[tauEstimate - 1] : yinBuffer[tauEstimate];
  const s1 = yinBuffer[tauEstimate];
  const s2 = tauEstimate + 1 < maxTau ? yinBuffer[tauEstimate + 1] : yinBuffer[tauEstimate];
  let betterTau = tauEstimate;
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom !== 0) {
    betterTau = tauEstimate + (s0 - s2) / denom;
  }

  return sampleRate / betterTau;
}
