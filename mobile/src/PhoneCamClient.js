// Talks to the PhoneCam server on the PC and streams the camera to every
// browser tab that asks for it (one WebRTC connection per tab).
//
// Pairing (the key itself never goes over the network — see server.js):
//   <- {type:'challenge', nonce: sn}
//   -> {type:'auth', nonce: pn, proof: HMAC(key, "phone|sn|pn")}
//   <- {type:'auth-ok', proof: HMAC(key, "server|sn|pn")}    we check it: it's really our PC
// Then every message is signed: {m: json, s: seq, h: HMAC(session, "<p|s>|seq|json")}.
//
// Messages (same as server/public/test-phone.js):
//   -> {type:'hello', name}
//   <- {type:'viewer-join', id}        create a connection, send the offer
//   <- {type:'viewer-leave', id}       close it
//   <- {type:'signal', from, data}     answer / ICE candidate from a tab
//   -> {type:'signal', to, data}       our offer / ICE candidates
//   <- {type:'replaced'}               another phone took over

import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCRtpSender } from 'react-native-webrtc';
import { getRandomBytes } from 'expo-crypto';
import { hmacHex, hexEqual } from './hmac';

const randomHex = (n) => Array.from(getRandomBytes(n), (b) => b.toString(16).padStart(2, '0')).join('');

// Enough for a sharp picture without filling the Wi-Fi link (a full link = queued
// packets = delay). Battery saver halves it.
const MAX_BITRATE = { 480: 1_200_000, 720: 2_500_000, 1080: 4_500_000 };

export default class PhoneCamClient {
  constructor({ host, port, key, name, onChange }) {
    this.url = `ws://${host}:${port}/ws?role=phone`;
    this.key = key;
    this.session = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    // The PhoneCam server answers STUN on the same port, so the phone learns the
    // address it appears as from the PC (needed when it's behind a second router).
    this.iceServers = [{ urls: `stun:${host}:${port}` }];
    this.name = name;
    this.onChange = onChange;
    this.ws = null;
    this.peers = new Map(); // viewer id -> RTCPeerConnection
    this.stream = null;
    this.quality = 720;
    this.batterySaver = false;
    this.stopped = false;
    this.retryDelay = 1000;
    this.retryTimer = null;
    this.queue = Promise.resolve();
    this.state = { server: 'connecting', viewers: 0, error: null };
  }

  start(stream) {
    this.stream = stream;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.ws?.close();
    this.ws = null;
  }

  // Swap in new tracks (e.g. after the camera was re-opened) without renegotiating.
  replaceStream(stream) {
    this.stream = stream;
    for (const pc of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        const next = stream.getTracks().find((t) => t.kind === sender.track?.kind);
        if (next) sender.replaceTrack(next);
      }
    }
  }

  setQuality(height, batterySaver = false) {
    this.quality = height;
    this.batterySaver = batterySaver;
    for (const pc of this.peers.values()) this.tuneSender(pc);
  }

  // ---------------------------------------------------------------------------

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.state);
  }

  connect() {
    if (this.stopped) return;
    this.update({ server: 'connecting' });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    this.session = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    let serverNonce = null;
    let phoneNonce = null;

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }

      // ---- Pairing handshake ----
      if (!this.session) {
        if (frame.type === 'challenge' && !serverNonce) {
          serverNonce = String(frame.nonce);
          phoneNonce = randomHex(16);
          ws.send(JSON.stringify({ type: 'auth', nonce: phoneNonce, proof: hmacHex(this.key, `phone|${serverNonce}|${phoneNonce}`) }));
        } else if (frame.type === 'auth-ok' && serverNonce) {
          if (!hexEqual(frame.proof, hmacHex(this.key, `server|${serverNonce}|${phoneNonce}`))) {
            // Something answered that doesn't know our key: not our PC.
            this.fail('impostor');
            return;
          }
          this.session = hmacHex(this.key, `session|${serverNonce}|${phoneNonce}`);
          this.retryDelay = 1000;
          this.update({ server: 'connected', error: null });
          this.send({ type: 'hello', name: this.name });
        }
        return;
      }

      // ---- Signed messages ----
      const s = Number(frame.s);
      if (typeof frame.m !== 'string' || !(s > this.recvSeq) ||
          !hexEqual(frame.h, hmacHex(this.session, `s|${s}|${frame.m}`))) {
        ws.close();
        return;
      }
      this.recvSeq = s;
      let msg;
      try { msg = JSON.parse(frame.m); } catch { return; }
      // In order: an ICE candidate must not overtake the answer it belongs to.
      this.queue = this.queue.then(() => this.handle(msg)).catch((err) => console.warn('[PhoneCam]', err));
    };

    ws.onerror = () => {
      // onclose follows; just remember why.
      this.update({ error: 'unreachable' });
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const id of [...this.peers.keys()]) this.closePeer(id);
      if (this.stopped) return;
      if (e.code === 4000) {
        this.stopped = true;
        this.update({ server: 'replaced' });
        return;
      }
      if (e.code === 4003) {
        this.fail('wrong-key');
        return;
      }
      this.update({ server: 'connecting' });
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
  }

  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.session) return;
    const m = JSON.stringify(msg);
    const s = ++this.sendSeq;
    this.ws.send(JSON.stringify({ m, s, h: hmacHex(this.session, `p|${s}|${m}`) }));
  }

  // Permanent problems: don't keep retrying.
  fail(reason) {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.update({ server: reason });
  }

  async handle(msg) {
    switch (msg.type) {
      case 'viewer-join':
        await this.openPeer(msg.id);
        break;
      case 'viewer-leave':
        this.closePeer(msg.id);
        break;
      case 'signal': {
        const pc = this.peers.get(msg.from);
        if (!pc || !msg.data) return;
        if (msg.data.sdp) await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
        else if (msg.data.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate)).catch(() => {});
        break;
      }
      case 'replaced':
        this.stopped = true;
        this.update({ server: 'replaced' });
        break;
    }
  }

  async openPeer(id) {
    this.closePeer(id);
    if (!this.stream) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peers.set(id, pc);
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));

    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
      this.send({ type: 'signal', to: id, data: { candidate: { candidate, sdpMid, sdpMLineIndex } } });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.closePeer(id);
      this.countViewers();
    });

    this.preferHardwareCodec(pc);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    this.send({ type: 'signal', to: id, data: { sdp: { type: offer.type, sdp: offer.sdp } } });
    this.tuneSender(pc);
    this.countViewers();
  }

  // H.264 is encoded by the phone's hardware; VP8/VP9 would be software, which
  // can't keep up at HD on mid-range phones (frames queue up = seconds of delay).
  preferHardwareCodec(pc) {
    try {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
      const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
      if (!h264.length) return;
      const transceiver = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video');
      transceiver?.setCodecPreferences([...h264, ...codecs.filter((c) => !/h264/i.test(c.mimeType))]);
    } catch (err) {
      console.warn('[PhoneCam] codec preference', err);
    }
  }

  async tuneSender(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const enc = params.encodings[0];
      enc.maxBitrate = (MAX_BITRATE[this.quality] || MAX_BITRATE[720]) / (this.batterySaver ? 2 : 1);
      enc.maxFramerate = this.batterySaver ? 15 : 30;
      // Cameras sometimes deliver more than asked (e.g. 1080p for 720p); encode at the chosen size.
      const { width = 0, height = 0 } = sender.track?.getSettings?.() || {};
      const shortSide = Math.min(width, height);
      enc.scaleResolutionDownBy = shortSide > this.quality ? shortSide / this.quality : 1;
      // Under load drop a little resolution and frame rate instead of queueing frames.
      params.degradationPreference = 'balanced';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[PhoneCam] could not tune sender', err);
    }
  }

  closePeer(id) {
    const pc = this.peers.get(id);
    if (!pc) return;
    this.peers.delete(id);
    pc.close();
    this.countViewers();
  }

  countViewers() {
    let live = 0;
    for (const pc of this.peers.values()) if (pc.connectionState === 'connected') live++;
    if (live !== this.state.viewers) this.update({ viewers: live });
  }
}
