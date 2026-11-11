// Mesh WebRTC: у каждой пары один инициатор (меньший peerId) делает единственный offer.
// Дальше треки меняются только через replaceTrack — без повторных переговоров.

function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const extra = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '128000', usedtx: '0', useinbandfec: '1' };
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_, params) => {
    const kv = Object.fromEntries(params.split(';').filter(Boolean).map((p) => p.split('=')));
    Object.assign(kv, extra);
    return `a=fmtp:${pt} ` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';');
  });
}

export class Mesh {
  constructor({ send, iceServers, onStream, onPeerState }) {
    this.send = send;
    this.iceServers = iceServers;
    this.onStream = onStream;
    this.onPeerState = onPeerState || (() => {});
    this.peers = new Map();
    this.myId = null;
    this.audioTrack = null;
    this.videoTrack = null;
  }

  setTracks({ audio, video }) {
    if (audio !== undefined) this.audioTrack = audio;
    if (video !== undefined) this.videoTrack = video;
    for (const p of this.peers.values()) this.#applyTracks(p);
  }

  #applyTracks(p) {
    for (const t of p.pc.getTransceivers()) {
      const kind = t.receiver.track?.kind;
      if (!kind || t.stopped || t.currentDirection === 'stopped') continue;
      const track = kind === 'audio' ? this.audioTrack : this.videoTrack;
      if (t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
    }
    this.#tuneBitrate(p);
  }

  async #tuneBitrate(p) {
    for (const s of p.pc.getSenders()) {
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      const max = s.track.kind === 'audio' ? 128000 : 600000;
      if (params.encodings[0].maxBitrate === max) continue;
      params.encodings[0].maxBitrate = max;
      if (s.track.kind === 'audio') params.encodings[0].priority = 'high';
      try { await s.setParameters(params); } catch {}
    }
  }

  // Синхронизировать набор соединений с текущим списком участников.
  sync(myId, peerIds) {
    this.myId = myId;
    const want = new Set(peerIds.filter((id) => id !== myId));
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.close(id);
    for (const id of want) if (!this.peers.has(id)) this.#create(id);
  }

  #create(id) {
    const initiator = this.myId < id;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const p = { id, pc, initiator, pending: [], stream: new MediaStream(), restartTimer: null };
    this.peers.set(id, p);

    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      const old = p.stream.getTracks().find((t) => t.kind === e.track.kind);
      if (old) p.stream.removeTrack(old);
      p.stream.addTrack(e.track);
      this.onStream(id, p.stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      this.onPeerState(id, st);
      if (st === 'connected') { clearTimeout(p.restartTimer); this.#tuneBitrate(p); }
      if (initiator && (st === 'failed' || st === 'disconnected')) {
        clearTimeout(p.restartTimer);
        p.restartTimer = setTimeout(() => {
          if (['failed', 'disconnected'].includes(pc.connectionState)) pc.restartIce();
        }, st === 'failed' ? 0 : 4000);
      }
    };

    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp) });
          this.send(id, { sdp: pc.localDescription });
        } catch (e) { console.warn('offer failed', e); }
      };
      pc.addTransceiver(this.audioTrack || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(this.videoTrack || 'video', { direction: 'sendrecv' });
    }
    return p;
  }

  async handleSignal(from, data) {
    let p = this.peers.get(from);
    if (!p) return; // ещё не знаем о таком участнике — придёт со следующим состоянием
    const { pc } = p;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          for (const t of pc.getTransceivers()) if (t.direction !== 'sendrecv' && !t.stopped) t.direction = 'sendrecv';
          this.#applyTracks(p);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp) });
          this.send(from, { sdp: pc.localDescription });
        }
        for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pending.push(data.candidate);
      }
    } catch (e) { console.warn('signal failed', e); }
  }

  // Оценка задержки голоса до участника (секунды): половина RTT + буфер джиттера.
  async latencyTo(id) {
    const p = this.peers.get(id);
    if (!p) return null;
    try {
      const stats = await p.pc.getStats();
      let rtt = null, jitter = 0;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount) {
          jitter = r.jitterBufferDelay / r.jitterBufferEmittedCount;
        }
      });
      return rtt == null ? null : rtt / 2 + jitter + 0.02;
    } catch { return null; }
  }

  close(id) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.restartTimer);
    p.pc.close();
    this.peers.delete(id);
    this.onStream(id, null);
  }

  closeAll() { for (const id of [...this.peers.keys()]) this.close(id); }
}
