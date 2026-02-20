/**
 * Qtone Web – Main app: Canvas tuner UI, controls, event handling.
 *
 * Layout matches iOS exactly:
 *   - Inner ring segments start at -15° from 3 o'clock (right)
 *   - Outer ring segments start at 0° (3 o'clock)
 *   - Inner labels placed at index * 30° from 12 o'clock (top)
 *   - Outer labels placed at index * 30° + 15° from top
 *   - Touch segment indices + the +3 shift in getNoteFrequency = correct pitch
 *   - Green indicator always visible (defaults to Do position when idle)
 */
(() => {
  // ── Note data (matching iOS) ──
  const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Mib', 'Mi', 'Fa', 'Fa#', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
  const QUARTER_NAMES = ['Do+', 'Re-', 'Re+', 'Mi-', 'Mi+', 'Fa+', 'Sol-', 'Sol+', 'La-', 'La+', 'Si-', 'Si+'];
  const ALL_24_NAMES = [
    'Do', 'Do+', 'Do#', 'Re-', 'Re', 'Re+', 'Mib', 'Mi-',
    'Mi', 'Mi+', 'Fa', 'Fa+', 'Fa#', 'Sol-', 'Sol', 'Sol+',
    'Lab', 'La-', 'La', 'La+', 'Sib', 'Si-', 'Si', 'Si+'
  ];

  const MIDDLE_C = 261.63;
  const SEGMENTS = 12;
  const SEG_ANGLE = (Math.PI * 2) / SEGMENTS; // 30° per segment
  const DEG = Math.PI / 180;

  // ── State ──
  let selectedOctave = 4;
  let fineTuneCents = 0;
  let detectedNote = '--';
  let detectedOctave = -1;
  let detectedCents = 0;
  let detectedQuarter = '--';
  let lastPlayedIndex = -1;
  let lastPlayedType = '';
  let isPlaying = false;
  let micStarted = false;

  // When playing a reference tone, show the played note directly
  // instead of relying on the mic to detect its own output.
  let playingNote = null;    // e.g. 'Do'
  let playingOctave = -1;
  let playingCents = 0;
  let playingQuarter = null;

  // ── Canvas setup ──
  const canvas = document.getElementById('tuner-canvas');
  const ctx = canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;
  let canvasSize = 340;

  function resizeCanvas() {
    const container = document.getElementById('tuner-container');
    canvasSize = container.clientWidth;
    canvas.width = canvasSize * dpr;
    canvas.height = canvasSize * dpr;
    canvas.style.width = canvasSize + 'px';
    canvas.style.height = canvasSize + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Radii (scale relative to 340px base) ──
  function s(base) { return base * (canvasSize / 340); }
  function outerR()      { return s(150); }
  function innerR()      { return s(95); }
  function indicatorR()  { return s(127); }
  function outerStroke() { return s(30); }
  function innerStroke() { return s(48); }
  function cx()          { return canvasSize / 2; }
  function cy()          { return canvasSize / 2; }

  // ── Colors ──
  const ACCENT = '#7F5FFF';
  const GREEN  = '#00FFC6';
  const TEXT   = '#E0E0E0';

  function rgba(hex, a) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── Frequency / note logic (matching iOS TunerModel, +3 shift preserved) ──
  function getNoteFrequency(noteName, octave) {
    const idx = NOTE_NAMES.indexOf(noteName);
    if (idx === -1) return MIDDLE_C;
    const semitonesFromC4 = ((idx + 3) % 12) + (octave - 4) * 12;
    return MIDDLE_C * Math.pow(2, semitonesFromC4 / 12);
  }

  // ── Pitch detection processing ──
  function processPitch(pitch, amplitude) {
    if (pitch <= 0 || amplitude <= 0) {
      detectedNote = '--';
      detectedOctave = -1;
      detectedCents = 0;
      detectedQuarter = '--';
      return;
    }

    const noteNumber = 12 * Math.log2(pitch / MIDDLE_C) + 60;
    const roundedNote = Math.round(noteNumber);
    const oct = Math.floor(roundedNote / 12) - 1;
    let noteIndex = ((roundedNote % 12) + 12) % 12;

    if (noteIndex >= 0 && noteIndex < NOTE_NAMES.length) {
      detectedOctave = oct;
      detectedNote = NOTE_NAMES[noteIndex];
      let cents = (noteNumber - roundedNote) * 100;
      if (cents > 50) cents -= 100;
      // Apply extra smoothing on cents for stable display
      detectedCents = AudioEngine.smoothCents(noteIndex, cents);

      // Use smoothed cents for quarter-tone name to match indicator/display
      const totalQ = noteIndex * 2 + (detectedCents / 50);
      const roundedQ = Math.round(totalQ);
      const qIdx = ((roundedQ % 24) + 24) % 24;
      detectedQuarter = ALL_24_NAMES[qIdx];
    }
  }

  // ══════════════════════════════════════════════════════
  // Drawing
  // ══════════════════════════════════════════════════════

  function drawArc(x, y, radius, startAngle, endAngle, lineWidth, color) {
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, endAngle, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  /** Draw a segmented ring. */
  function drawRing(x, y, radius, strokeW, rotationRad) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = rotationRad + i * SEG_ANGLE;
      const a1 = rotationRad + (i + 1) * SEG_ANGLE;
      const alpha = (i % 2 === 0) ? 0.35 : 0.18;
      drawArc(x, y, radius, a0, a1, strokeW, rgba(ACCENT, alpha));
    }
  }

  function drawCircle(x, y, radius) {
    drawArc(x, y, radius, 0, Math.PI * 2, 1, ACCENT);
  }

  /**
   * Green indicator arc — ALWAYS drawn (matching iOS).
   * When no pitch detected, defaults to noteIndex 0 / cents 0 (Do position).
   */
  function drawIndicator(x, y) {
    // Use playing note when actively tapping, otherwise detected note
    const activeNote = playingNote || detectedNote;
    const activeCents = playingNote ? playingCents : detectedCents;
    const noteIndex = NOTE_NAMES.indexOf(activeNote);
    const idx = noteIndex === -1 ? 0 : noteIndex;
    const cents = activeNote === '--' ? 0 : activeCents;

    // iOS formula: totalQ * 360/24 - 90 - 15 (degrees)
    const totalQ = idx * 2 + cents / 50;
    const angleDeg = totalQ * 360 / 24 - 90 - 15;
    const startRad = angleDeg * DEG;
    const spanRad = SEG_ANGLE; // 30° = 1/12 circle
    drawArc(x, y, indicatorR(), startRad, startRad + spanRad, s(14), GREEN);
  }

  /**
   * Draw a text label at a specific angle on a ring.
   * angle: canvas angle in radians (0=right, clockwise).
   */
  function drawLabelAt(x, y, radius, angle, text, fontSize) {
    const lx = x + radius * Math.cos(angle);
    const ly = y + radius * Math.sin(angle);

    ctx.save();
    ctx.translate(lx, ly);

    // Rotate text to follow the circle (like iOS rotationEffect).
    // Add π/2 so text reads outward along the tangent.
    let textAngle = angle + Math.PI / 2;
    // Flip text on bottom half so it's never upside-down.
    if (angle > 0 && angle < Math.PI) {
      textAngle += Math.PI;
    }
    ctx.rotate(textAngle);

    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Render accidentals (#, b, +, -) as superscript
    const match = text.match(/^(.+?)([#b+\-])$/);
    if (match) {
      const base = match[1];
      const acc = match[2];
      ctx.font = `${fontSize}px Audiowide, sans-serif`;
      const baseW = ctx.measureText(base).width;
      const accFontSize = Math.round(fontSize * 0.7);
      ctx.font = `${accFontSize}px Audiowide, sans-serif`;
      const accW = ctx.measureText(acc).width;
      const totalW = baseW + accW;

      ctx.font = `${fontSize}px Audiowide, sans-serif`;
      ctx.fillText(base, -totalW / 2 + baseW / 2, 0);
      ctx.font = `${accFontSize}px Audiowide, sans-serif`;
      ctx.fillText(acc, -totalW / 2 + baseW + accW / 2, -fontSize * 0.25);
    } else {
      ctx.font = `${fontSize}px Audiowide, sans-serif`;
      ctx.fillText(text, 0, 0);
    }

    ctx.restore();
  }

  function draw() {
    const x = cx(), y = cy();
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // ── Outer ring (quarter-tones) ──
    // iOS: net rotation = 0 (segments start at 3 o'clock)
    drawRing(x, y, outerR(), outerStroke(), 0);
    drawCircle(x, y, outerR() + outerStroke() / 2);
    drawCircle(x, y, outerR() - outerStroke() / 2);

    // ── Inner ring (semitones) ──
    // iOS: rotated -15° from 3 o'clock
    drawRing(x, y, innerR(), innerStroke(), -15 * DEG);
    drawCircle(x, y, innerR() + innerStroke() / 2);
    drawCircle(x, y, innerR() - innerStroke() / 2);

    // ── Green indicator (always visible) ──
    drawIndicator(x, y);

    // ── Outer labels ──
    // iOS: index * 30° + 15° from top
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = -Math.PI / 2 + (i * 30 + 15) * DEG;
      drawLabelAt(x, y, outerR(), angle, QUARTER_NAMES[i], s(14));
    }

    // ── Inner labels ──
    // iOS: index * 30° from top (the +15 and -15 rotations cancel)
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = -Math.PI / 2 + i * 30 * DEG;
      drawLabelAt(x, y, innerR(), angle, NOTE_NAMES[i], s(18));
    }

    requestAnimationFrame(draw);
  }

  // ══════════════════════════════════════════════════════
  // DOM display update
  // ══════════════════════════════════════════════════════

  function updateDisplay() {
    const noteEl = document.getElementById('note-name');
    const quarterEl = document.getElementById('quarter-name');
    const centsEl = document.getElementById('cents-display');

    // Use playing note when actively tapping, otherwise detected note
    const activeNote = playingNote || detectedNote;
    const activeOctave = playingNote ? playingOctave : detectedOctave;
    const activeQuarter = playingNote ? (playingQuarter || activeNote) : detectedQuarter;
    const activeCents = playingNote ? playingCents : detectedCents;

    const octStr = activeOctave === -1 ? '-' : String(activeOctave);
    noteEl.textContent = activeNote + octStr;
    quarterEl.textContent = activeQuarter;
    const clampedCents = Math.max(-50, Math.min(50, activeCents));
    centsEl.textContent = Math.round(clampedCents) + ' cents';
    if (Math.abs(activeCents) <= 5 && activeNote !== '--') {
      centsEl.classList.add('in-tune');
    } else {
      centsEl.classList.remove('in-tune');
    }
    requestAnimationFrame(updateDisplay);
  }

  // ══════════════════════════════════════════════════════
  // Touch / click interaction
  // ══════════════════════════════════════════════════════

  function getCanvasXY(e) {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: (touch.clientX - rect.left) * (canvasSize / rect.width),
      y: (touch.clientY - rect.top) * (canvasSize / rect.height)
    };
  }

  /**
   * Map touch position to a ring segment and play the note.
   *
   * iOS geometry:
   *   angle = atan2(dy, dx)  (0 = right, CW positive in screen coords)
   *   normAngle = (angle < -15° ? angle + 360° : angle) + 15°
   *   inner segment = floor(normAngle / 30°) % 12
   *   outer: outerAngle = normAngle - 15° → segment = floor(outerAngle / 30°) % 12
   *          which simplifies to raw angle (no offset)
   */
  function handlePointerOnCanvas(x, y) {
    const ccx = cx(), ccy = cy();
    const dx = x - ccx;
    const dy = y - ccy;
    const radius = Math.sqrt(dx * dx + dy * dy);

    // atan2 in screen coords: 0=right, positive=clockwise (because y is down)
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;

    const outerOuter = outerR() + outerStroke() / 2;
    const outerInner = outerR() - outerStroke() / 2;
    const innerOuter = innerR() + innerStroke() / 2;
    const innerInner = innerR() - innerStroke() / 2;

    if (radius >= outerInner && radius <= outerOuter) {
      // ── Outer ring (quarter-tones) ──
      // iOS: outerAngle = raw angle normalized to 0..360
      let outerAngle = angleDeg;
      if (outerAngle < 0) outerAngle += 360;
      const segment = Math.floor(outerAngle / 30) % 12;
      if (lastPlayedIndex !== segment || lastPlayedType !== 'quarter') {
        playQuarterTone(segment, selectedOctave);
        lastPlayedIndex = segment;
        lastPlayedType = 'quarter';
        isPlaying = true;
      }
    } else if (radius >= innerInner && radius <= innerOuter) {
      // ── Inner ring (semitones) ──
      // iOS: normAngle = (angle < -15 ? angle+360 : angle) + 15
      let normAngle = angleDeg;
      if (normAngle < -15) normAngle += 360;
      normAngle += 15;
      const segment = Math.floor(normAngle / 30) % 12;
      if (lastPlayedIndex !== segment || lastPlayedType !== 'semitone') {
        tunerStartPlayingNote(segment, selectedOctave);
        lastPlayedIndex = segment;
        lastPlayedType = 'semitone';
        isPlaying = true;
      }
    } else {
      stopPlaying();
    }
  }

  /** Play a semitone by segment index (matching iOS inner ring touch). */
  function tunerStartPlayingNote(segment, octave) {
    const freq = getNoteFrequency(NOTE_NAMES[segment], octave);
    AudioEngine.startTone(freq);

    // Display the LABEL note (segment→label uses +3 shift, same as freq calc)
    const displayNote = NOTE_NAMES[(segment + 3) % 12];
    playingNote = displayNote;
    playingOctave = octave;
    playingCents = 0;
    playingQuarter = displayNote;
  }

  /**
   * Play a quarter-tone by segment index (matching iOS outer ring touch).
   * iOS: visualIndex = (quarterIndex + 3) % 12
   */
  function playQuarterTone(quarterIndex, octave) {
    const visualIndex = (quarterIndex + 3) % 12;
    const name = QUARTER_NAMES[visualIndex];
    const isPlus = name.endsWith('+');
    const isMinus = name.endsWith('-');

    let baseNoteIndex, quarterOffset;
    if (isPlus) {
      baseNoteIndex = quarterIndex % 12;
      quarterOffset = 42;
    } else if (isMinus) {
      baseNoteIndex = (quarterIndex + 1) % 12;
      quarterOffset = -42;
    } else {
      baseNoteIndex = quarterIndex % 12;
      quarterOffset = 0;
    }

    const baseFreq = getNoteFrequency(NOTE_NAMES[baseNoteIndex], octave);
    const freq = baseFreq * Math.pow(2, quarterOffset / 1200);
    AudioEngine.startTone(freq);

    // Display the LABEL note (+3 shift maps segment index to visual label)
    playingNote = NOTE_NAMES[(baseNoteIndex + 3) % 12];
    playingOctave = octave;
    playingCents = quarterOffset;
    playingQuarter = name;
  }

  function stopPlaying() {
    if (isPlaying) {
      AudioEngine.stopTone();
      lastPlayedIndex = -1;
      lastPlayedType = '';
      isPlaying = false;
      // Clear playing override — revert to mic detection
      playingNote = null;
      playingOctave = -1;
      playingCents = 0;
      playingQuarter = null;
    }
  }

  // ── Canvas event listeners ──
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    AudioEngine.getContext();
    const { x, y } = getCanvasXY(e);
    handlePointerOnCanvas(x, y);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (e.buttons === 1) {
      const { x, y } = getCanvasXY(e);
      handlePointerOnCanvas(x, y);
    }
  });
  canvas.addEventListener('mouseup', stopPlaying);
  canvas.addEventListener('mouseleave', stopPlaying);

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    AudioEngine.getContext();
    const { x, y } = getCanvasXY(e);
    handlePointerOnCanvas(x, y);
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const { x, y } = getCanvasXY(e);
    handlePointerOnCanvas(x, y);
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    stopPlaying();
  }, { passive: false });
  canvas.addEventListener('touchcancel', stopPlaying);

  // ══════════════════════════════════════════════════════
  // Controls
  // ══════════════════════════════════════════════════════

  document.getElementById('octave-down').addEventListener('click', () => {
    if (selectedOctave > 0) {
      selectedOctave--;
      document.getElementById('octave-value').textContent = selectedOctave;
    }
  });
  document.getElementById('octave-up').addEventListener('click', () => {
    if (selectedOctave < 8) {
      selectedOctave++;
      document.getElementById('octave-value').textContent = selectedOctave;
    }
  });

  function updatePitchDisplay() {
    const sign = fineTuneCents >= 0 ? '+' : '';
    document.getElementById('pitch-value').textContent = sign + fineTuneCents + ' ct';
  }

  document.getElementById('pitch-down').addEventListener('click', () => {
    if (fineTuneCents > -50) {
      fineTuneCents--;
      AudioEngine.setFineTuneCents(fineTuneCents);
      updatePitchDisplay();
    }
  });
  document.getElementById('pitch-up').addEventListener('click', () => {
    if (fineTuneCents < 50) {
      fineTuneCents++;
      AudioEngine.setFineTuneCents(fineTuneCents);
      updatePitchDisplay();
    }
  });

  document.querySelectorAll('.sound-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sound-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AudioEngine.setWaveform(btn.dataset.sound);
      fineTuneCents = 0;
      AudioEngine.setFineTuneCents(0);
      updatePitchDisplay();
    });
  });

  // ══════════════════════════════════════════════════════
  // Microphone startup
  // ══════════════════════════════════════════════════════

  async function startMic() {
    if (micStarted) return;
    micStarted = true;
    document.getElementById('mic-prompt').style.display = 'none';
    await AudioEngine.startMicrophone((pitch, amplitude) => {
      processPitch(pitch, amplitude);
    });
  }

  function initMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micStarted = true;
      return;
    }
    document.getElementById('mic-prompt').style.display = 'flex';
    const handler = () => {
      startMic();
      document.removeEventListener('click', handler);
      document.removeEventListener('touchstart', handler);
    };
    document.addEventListener('click', handler);
    document.addEventListener('touchstart', handler);
  }

  // ── Init ──
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  requestAnimationFrame(draw);
  requestAnimationFrame(updateDisplay);
  initMic();
})();
