import { Emitter } from './emitter';
import { isLocalCandidate, sanitizeSdp } from './netfilter';
import type { RelayMsg } from './protocol';

// Local network only: no STUN/TURN servers, so WebRTC never learns a public
// address and never relays media through the internet. On top of that every
// candidate (sent or received) is checked to be a private/link-local/mDNS
// host address — if two devices aren't on the same network they simply
// can't connect.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
};

const cleanDesc = (d: RTCSessionDescriptionInit): RTCSessionDescriptionInit => ({ type: d.type, sdp: sanitizeSdp(d.sdp) });

/**
 * One RTCPeerConnection to a remote peer, using the "perfect negotiation"
 * pattern so either side may renegotiate at any time without glare.
 * Source devices are impolite (they publish, offer, and open the control
 * data channel); the studio is polite.
 *
 * Once connected, control/tally messages travel over the direct data channel
 * instead of the signaling path.
 */
export class PeerLink extends Emitter<{
  track: [MediaStreamTrack, MediaStream | null];
  state: [RTCPeerConnectionState];
  message: [RelayMsg];
}> {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private closed = false;

  constructor(
    readonly remoteId: string,
    private polite: boolean,
    private signal: (msg: RelayMsg) => void,
  ) {
    super();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    if (!polite) this.attachChannel(pc.createDataChannel('control', { ordered: true }));
    pc.ondatachannel = (ev) => this.attachChannel(ev.channel);

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.signal({ kind: 'rtc', description: cleanDesc(pc.localDescription.toJSON()) });
      } catch (err) {
        console.warn('[rtc] offer failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && !isLocalCandidate(candidate.candidate)) return; // never advertise non-local addresses
      this.signal({ kind: 'rtc', candidate: candidate ? candidate.toJSON() : null });
    };
    pc.ontrack = (ev) => this.emit('track', ev.track, ev.streams[0] ?? null);
    pc.onconnectionstatechange = () => {
      this.emit('state', pc.connectionState);
      if (pc.connectionState === 'failed' && !this.polite) pc.restartIce();
    };
  }

  get state() {
    return this.pc.connectionState;
  }

  /** Direct connection up (media + control channel). Survives signaling outages. */
  get alive() {
    return this.pc.connectionState === 'connected' && this.channel?.readyState === 'open';
  }

  /** Send over the direct data channel. Returns false if it isn't open yet. */
  send(msg: RelayMsg): boolean {
    if (this.channel?.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private attachChannel(ch: RTCDataChannel) {
    this.channel = ch;
    // Channel open/close changes `alive`; let listeners re-evaluate.
    ch.onopen = () => this.emit('state', this.pc.connectionState);
    ch.onclose = () => this.emit('state', this.pc.connectionState);
    ch.onmessage = (ev) => {
      try {
        this.emit('message', JSON.parse(ev.data));
      } catch {
        /* ignore malformed */
      }
    };
  }

  async handle(msg: RelayMsg) {
    if (msg.kind !== 'rtc' || this.closed) return;
    const pc = this.pc;
    try {
      if (msg.description) {
        const desc = cleanDesc(msg.description);
        const readyForOffer =
          !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const offerCollision = desc.type === 'offer' && !readyForOffer;
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;

        this.settingRemoteAnswer = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        this.settingRemoteAnswer = false;
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.signal({ kind: 'rtc', description: cleanDesc(pc.localDescription.toJSON()) });
        }
      } else if (msg.candidate !== undefined) {
        if (msg.candidate && !isLocalCandidate(msg.candidate.candidate ?? '')) return; // refuse non-local paths
        try {
          await pc.addIceCandidate(msg.candidate ?? undefined);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[rtc] signaling error', err);
    }
  }

  close() {
    this.closed = true;
    this.channel?.close();
    this.pc.close();
    this.emit('state', 'closed');
  }
}

/** Cap the outgoing bitrate for a sender (best effort). */
export async function setMaxBitrate(sender: RTCRtpSender, bitrate: number) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    await sender.setParameters(params);
  } catch {
    /* encodings not ready yet or unsupported */
  }
}
