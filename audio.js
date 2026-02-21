/**
 * Audio engine: microphone input + pitch detection + reference tone playback.
 */
const AudioEngine = (() => {
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let micSource = null;
  let micGain = null;
  let dataBuffer = null;
  let isListening = false;
  let animFrameId = null;

  // Pitch detection state
  let smoothedPitch = 0;
  let smoothedCentsNote = -1;
  let smoothedCents = 0;
  let jumpCount = 0;
  let jumpCandidate = 0;
  let onPitchDetected = null;

  // Reference tone state
  let selectedWaveform = 'triangle';

  const AMPLITUDE_THRESHOLD = 0.005;
  const PITCH_SMOOTHING = 0.7;
  const CENTS_SMOOTHING = 0.88;
  const CENTS_DEADZONE = 1.5;
  const BUFFER_SIZE = 4096;
  const JUMP_CONFIRM = 3;
  const MIC_BOOST = 4.0;

  function getContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  async function startMicrophone(callback) {
    onPitchDetected = callback;
    const ctx = getContext();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      micSource = ctx.createMediaStreamSource(micStream);

      micGain = ctx.createGain();
      micGain.gain.value = MIC_BOOST;

      analyser = ctx.createAnalyser();
      analyser.fftSize = BUFFER_SIZE * 2;
      dataBuffer = new Float32Array(analyser.fftSize);

      micSource.connect(micGain);
      micGain.connect(analyser);

      isListening = true;
      detectLoop();
    } catch (e) {
      console.error('Microphone access denied:', e);
      isListening = false;
    }
  }

  function detectLoop() {
    if (!isListening) return;
    animFrameId = requestAnimationFrame(detectLoop);

    analyser.getFloatTimeDomainData(dataBuffer);

    let sumSq = 0;
    for (let i = 0; i < dataBuffer.length; i++) {
      sumSq += dataBuffer[i] * dataBuffer[i];
    }
    const amplitude = Math.sqrt(sumSq / dataBuffer.length);

    if (amplitude < AMPLITUDE_THRESHOLD) {
      smoothedPitch = 0;
      smoothedCentsNote = -1;
      if (onPitchDetected) onPitchDetected(0, 0);
      return;
    }

    const ctx = getContext();
    const pitch = detectPitch(dataBuffer, ctx.sampleRate);
    if (pitch > 0 && pitch < 5000) {
      if (smoothedPitch > 0) {
        const ratio = pitch / smoothedPitch;
        const isJump = ratio > 1.8 || ratio < 0.55;

        if (isJump) {
          const candRatio = jumpCandidate > 0 ? pitch / jumpCandidate : 0;
          const nearCandidate = candRatio > 0.9 && candRatio < 1.1;

          if (nearCandidate) {
            jumpCount++;
          } else {
            jumpCandidate = pitch;
            jumpCount = 1;
          }

          if (jumpCount >= JUMP_CONFIRM) {
            smoothedPitch = pitch;
            jumpCount = 0;
            jumpCandidate = 0;
          } else {
            if (onPitchDetected) onPitchDetected(smoothedPitch, amplitude);
            return;
          }
        } else {
          jumpCount = 0;
          jumpCandidate = 0;
          smoothedPitch = PITCH_SMOOTHING * smoothedPitch + (1 - PITCH_SMOOTHING) * pitch;
        }
      } else {
        smoothedPitch = pitch;
      }
      if (onPitchDetected) onPitchDetected(smoothedPitch, amplitude);
    } else {
      smoothedPitch = 0;
      smoothedCentsNote = -1;
      jumpCount = 0;
      jumpCandidate = 0;
      if (onPitchDetected) onPitchDetected(0, 0);
    }
  }

  function stopMicrophone() {
    isListening = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (micGain) {
      micGain.disconnect();
      micGain = null;
    }
    if (micSource) {
      micSource.disconnect();
      micSource = null;
    }
  }

  function setWaveform(type) {
    selectedWaveform = type;
  }

  let toneAudioEl = null; // <audio> element for tone playback

  /**
   * Generate a WAV blob for a loopable tone.
   * Uses <audio> element playback which goes through iOS media pipeline
   * at full volume (unlike Web Audio OscillatorNode which is quiet on iOS).
   */
  function generateToneWav(frequency, waveform, sampleRate, durationSec) {
    const numSamples = Math.round(sampleRate * durationSec);
    // Snap duration to whole cycles to avoid click at loop point
    const samplesPerCycle = sampleRate / frequency;
    const wholeCycles = Math.max(1, Math.round(numSamples / samplesPerCycle));
    const actualSamples = Math.round(wholeCycles * samplesPerCycle);

    const buffer = new Float32Array(actualSamples);
    for (let i = 0; i < actualSamples; i++) {
      const t = i / sampleRate;
      const phase = (frequency * t) % 1;
      const p2 = 2 * Math.PI * phase;
      switch (waveform) {
        case 'sine':
          // Add subtle odd harmonics so phone speakers can reproduce it.
          // Pure sine has no high-frequency energy → inaudible on tiny speakers.
          // Mix: fundamental 85% + 3rd harmonic 10% + 5th harmonic 5%
          buffer[i] = 0.85 * Math.sin(p2)
                    + 0.10 * Math.sin(3 * p2)
                    + 0.05 * Math.sin(5 * p2);
          break;
        case 'triangle':
          buffer[i] = 4 * Math.abs(phase - 0.5) - 1;
          break;
        case 'square':
          buffer[i] = phase < 0.5 ? 1 : -1;
          break;
        default:
          buffer[i] = Math.sin(p2);
      }
    }

    // Encode as 16-bit PCM WAV
    const bitsPerSample = 16;
    const byteRate = sampleRate * bitsPerSample / 8;
    const dataSize = actualSamples * (bitsPerSample / 8);
    const headerSize = 44;
    const wav = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(wav);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);         // chunk size
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, bitsPerSample / 8, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < actualSamples; i++) {
      const sample = Math.max(-1, Math.min(1, buffer[i]));
      view.setInt16(headerSize + i * 2, sample * 0x7FFF, true);
    }

    // Convert to base64 data URI (blob URLs don't always work on iOS).
    // Process in chunks to avoid O(n²) string concatenation.
    const bytes = new Uint8Array(wav);
    const chunkSize = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return 'data:audio/wav;base64,' + btoa(parts.join(''));
  }

  function startTone(frequency) {
    stopTone();
    const dataUri = generateToneWav(frequency, selectedWaveform, 44100, 10.0);

    toneAudioEl = new Audio(dataUri);
    toneAudioEl.loop = true;
    toneAudioEl.volume = 1.0;
    toneAudioEl.play();
  }

  function stopTone() {
    if (toneAudioEl) {
      toneAudioEl.pause();
      toneAudioEl = null;
    }
  }

  function smoothCents(noteIndex, rawCents) {
    if (noteIndex !== smoothedCentsNote) {
      smoothedCentsNote = noteIndex;
      smoothedCents = rawCents;
    } else {
      if (Math.abs(rawCents - smoothedCents) < CENTS_DEADZONE) {
        return smoothedCents;
      }
      smoothedCents = CENTS_SMOOTHING * smoothedCents + (1 - CENTS_SMOOTHING) * rawCents;
    }
    return smoothedCents;
  }

  return {
    getContext,
    startMicrophone,
    stopMicrophone,
    setWaveform,
    startTone,
    stopTone,
    smoothCents,
    get selectedWaveform() { return selectedWaveform; }
  };
})();
