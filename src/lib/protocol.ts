// Shared message and state types used by the studio, source devices and the
// signaling server (server/signaling.mjs mirrors the envelope shapes).

export type Role = 'studio' | 'source';
export type Facing = 'user' | 'environment';

/** One media track a source device publishes. `key` is stable per device. */
export interface PublishedSource {
  key: string; // e.g. 'camera', 'mic', 'screen', 'screen-audio'
  kind: 'video' | 'audio';
  /** MediaStream id the track is sent with; the studio maps ontrack streams by this. */
  streamId: string | null;
  label: string;
  enabled: boolean;
  facing?: Facing;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface SourceState {
  sources: PublishedSource[];
  canSwitchCamera?: boolean;
  canShareScreen?: boolean;
  battery?: number | null;
}

export interface PeerInfo {
  id: string;
  role: Role;
  name: string;
  deviceId: string;
  info: { ua?: string; platform?: string; mobile?: boolean };
  state: Partial<SourceState>;
  connectedAt: number;
}

export type ControlAction =
  | { action: 'setCamera'; value: boolean }
  | { action: 'setMic'; value: boolean }
  | { action: 'flipCamera' }
  | { action: 'setQuality'; value: QualityPreset }
  | { action: 'disconnect' };

export type QualityPreset = '720p' | '1080p' | '4k';

/** Messages relayed peer-to-peer through the signaling server. */
export type RelayMsg =
  | { kind: 'rtc'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null }
  | ({ kind: 'control' } & ControlAction)
  | { kind: 'tally'; program: string[]; preview: string[]; recording: boolean };

/** A URL this computer can be reached at, best first. */
export interface LanUrl {
  url: string;
  kind: 'lan' | 'vpn';
  label: string;
}

export type ServerMsg =
  | { t: 'welcome'; id: string; peers: PeerInfo[]; lanUrls: LanUrl[] }
  | { t: 'peers'; peers: PeerInfo[] }
  | { t: 'relay'; from: string; msg: RelayMsg }
  | { t: 'pong' };

export const QUALITY: Record<QualityPreset, { width: number; height: number; bitrate: number }> = {
  '720p': { width: 1280, height: 720, bitrate: 2_500_000 },
  '1080p': { width: 1920, height: 1080, bitrate: 6_000_000 },
  '4k': { width: 3840, height: 2160, bitrate: 16_000_000 },
};
