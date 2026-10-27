/**
 * Voice effects for spoken lines. The witch's voice gets a cavernous echo:
 * the TTS audio is routed through a feedback delay with a soft low-pass, so each
 * phrase rings on a little after she speaks. Made with the Web Audio API, no files.
 */
let context: AudioContext | null = null;

/** Route an <audio> element through an echo before it reaches the speakers. Call before play(). */
export function withEcho(audio: HTMLAudioElement): void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return; // no Web Audio: play the plain voice
  try {
    context ??= new Ctx();
    if (context.state === "suspended") void context.resume();
    const ctx = context;
    const source = ctx.createMediaElementSource(audio);
    const dry = ctx.createGain();
    dry.gain.value = 0.9;
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.24;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    source.connect(dry).connect(ctx.destination);
    source.connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(wet).connect(ctx.destination);
  } catch {
    // An element can only be routed once; fall back to the plain voice.
  }
}

/** How long the echo keeps ringing after the line ends. */
export const ECHO_TAIL_MS = 900;
