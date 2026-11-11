// Звук исполнителя: микрофон без «телефонной» обработки + реверберация (+ минусовка из файла).
// Наружу уходит один стерео-трек — слушатели получают готовый микс.

function impulseResponse(ctx, seconds = 2.4, decay = 3.2) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // небольшая предзадержка и мягкое затухание
      d[i] = i < rate * 0.012 ? 0 : (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

export class SingerMixer {
  constructor() {
    this.ctx = null;
    this.active = false;
  }

  // Вызывать из обработчика нажатия: iOS разрешает звук только после жеста пользователя.
  async prepare(file = null) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.#dropAudio();
    if (file) {
      const audio = new Audio();
      audio.src = URL.createObjectURL(file);
      audio.preload = 'auto';
      audio.playsInline = true;
      audio.muted = true;
      try { await audio.play(); audio.pause(); } catch {}
      audio.currentTime = 0;
      audio.muted = false;
      this.audio = audio;
    }
  }

  async start({ headphones = true, reverb = 0.3, monitor = false, file = null, musicVolume = 0.8 }) {
    this.#teardown();
    if (!this.ctx || (file && !this.audio)) await this.prepare(file);
    const ctx = this.ctx;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});

    // Без наушников минусовка из динамика попадёт в микрофон — тогда оставляем эхоподавление.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: !headphones, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });

    const nodes = (this.nodes = []);
    const n = (node) => (nodes.push(node), node);
    this.dest = n(ctx.createMediaStreamDestination());
    this.dest.channelCount = 2;

    const mic = n(ctx.createMediaStreamSource(this.micStream));
    const comp = n(ctx.createDynamicsCompressor());
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.mute = n(ctx.createGain());
    this.voice = n(ctx.createGain());
    this.voice.gain.value = 1.1;
    this.dry = n(ctx.createGain());
    this.wet = n(ctx.createGain());
    const conv = n(ctx.createConvolver());
    conv.buffer = impulseResponse(ctx);

    mic.connect(this.mute).connect(comp);
    comp.connect(this.dry).connect(this.voice);
    comp.connect(conv).connect(this.wet).connect(this.voice);
    this.voice.connect(this.dest);

    this.monitorGain = n(ctx.createGain());
    this.voice.connect(this.monitorGain).connect(ctx.destination);
    this.setReverb(reverb);
    this.setMonitor(monitor && headphones);

    if (this.audio) {
      this.music = n(ctx.createGain());
      this.music.gain.value = musicVolume;
      const src = n(ctx.createMediaElementSource(this.audio));
      src.connect(this.music);
      this.music.connect(this.dest);          // слушателям
      this.music.connect(ctx.destination);    // себе
      if (this.audio.readyState < 3) {
        await new Promise((res) => {
          this.audio.oncanplay = res;
          this.audio.onerror = res;
          setTimeout(res, 5000);
        });
      }
    }
    this.active = true;
    return this.dest.stream.getAudioTracks()[0];
  }

  // Запустить минусовку ровно в момент startAt (локальное время, мс).
  playAt(startAt, onEnded) {
    if (!this.audio) return;
    this.audio.onended = onEnded;
    const delay = startAt - Date.now();
    const go = () => {
      const late = (Date.now() - startAt) / 1000;
      if (late > 0.05 && late < (this.audio.duration || 1e9)) this.audio.currentTime = late;
      this.audio.play().catch((e) => console.warn('music play', e));
    };
    if (delay > 0) this.playTimer = setTimeout(go, delay); else go();
  }

  get progress() {
    if (!this.audio || !this.audio.duration) return null;
    return { t: this.audio.currentTime, d: this.audio.duration };
  }

  setReverb(v) {
    if (!this.ctx || !this.wet) return;
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(v * 0.9, now, 0.05);
    this.dry.gain.setTargetAtTime(1 - v * 0.35, now, 0.05);
  }
  setMonitor(on) { if (this.ctx && this.monitorGain) this.monitorGain.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05); }
  setMusicVolume(v) { if (this.music) this.music.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setVoiceMuted(m) { if (this.mute) this.mute.gain.value = m ? 0 : 1; }

  #dropAudio() {
    if (this.audio) { this.audio.pause(); URL.revokeObjectURL(this.audio.src); this.audio = null; }
  }

  #teardown() {
    clearTimeout(this.playTimer);
    for (const node of this.nodes || []) { try { node.disconnect(); } catch {} }
    this.nodes = [];
    this.music = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  // AudioContext не закрываем: новый вне жеста пользователя на iOS может не запуститься.
  async stop() {
    this.active = false;
    this.#teardown();
    this.#dropAudio();
  }
}
