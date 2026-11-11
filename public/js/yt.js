// YouTube: у каждого свой плеер, позиция подстраивается под общее время старта песни.

let apiPromise = null;
function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('YouTube недоступен'));
    document.head.appendChild(s);
  });
  return apiPromise;
}

export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

export class YouTubeSync {
  constructor(container, { onEnded, onError, onNeedsTap }) {
    this.container = container;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onNeedsTap = onNeedsTap;
    this.player = null;
    this.videoId = null;
    this.target = () => null;
    this.failedPlays = 0;
    this.ended = false;
    this.timer = setInterval(() => this.#tick(), 500);
  }

  async load(videoId, target) {
    this.target = target;
    if (this.videoId === videoId) return;
    this.videoId = videoId;
    this.ended = false;
    this.failedPlays = 0;
    const YT = await loadApi();
    if (this.videoId !== videoId) return;
    if (!this.player) {
      const el = document.createElement('div');
      this.container.replaceChildren(el);
      await new Promise((ready) => {
        this.player = new YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3 },
          events: {
            onReady: ready,
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED && !this.ended) { this.ended = true; this.onEnded?.(); }
              if (e.data === YT.PlayerState.PLAYING) { this.failedPlays = 0; this.onNeedsTap?.(false); }
            },
            onError: (e) => this.onError?.(e.data),
          },
        });
      });
    } else {
      this.player.cueVideoById(videoId);
    }
  }

  // Вызывать из обработчика нажатия, если браузер не дал запустить звук сам.
  tapToPlay() {
    this.failedPlays = 0;
    try { this.player?.playVideo(); } catch {}
  }

  setVolume(v) { try { this.player?.setVolume(Math.round(v * 100)); } catch {} }

  get duration() { try { return this.player?.getDuration() || 0; } catch { return 0; } }
  get time() { try { return this.player?.getCurrentTime() || 0; } catch { return 0; } }

  #tick() {
    const p = this.player;
    if (!p || !this.videoId || typeof p.getPlayerState !== 'function') return;
    const t = this.target();
    if (t == null) return;
    const st = p.getPlayerState();
    if (this.ended || st === 0) return;
    if (t < 0) { if (st === 1) p.pauseVideo(); return; }
    const dur = this.duration;
    if (dur && t > dur + 1) return;
    if (st === 1) {
      if (Math.abs(this.time - t) > 0.6) p.seekTo(t, true);
    } else if (st !== 3) {
      p.seekTo(t, true);
      p.playVideo();
      if (++this.failedPlays > 4) this.onNeedsTap?.(true);
    }
  }

  stop() {
    this.videoId = null;
    this.target = () => null;
    try { this.player?.stopVideo(); } catch {}
  }
}
