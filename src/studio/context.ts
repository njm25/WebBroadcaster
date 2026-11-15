import type { Room } from '../lib/room';
import type { SignalingLike } from '../lib/signaling';
import type { Compositor } from './compositor';
import type { Editor } from './editor';
import type { InputRegistry } from './inputs';
import type { LocalSources } from './local';
import type { Mixer } from './mixer';
import type { Recorder } from './recorder';
import type { RemoteManager } from './remote';
import type { SceneStore } from './scenes';

export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
  formatId: string;
  videoBitrate: number;
  toDisk: boolean;
}

export interface Studio {
  sig: SignalingLike;
  registry: InputRegistry;
  remote: RemoteManager;
  local: LocalSources;
  store: SceneStore;
  comp: Compositor;
  editor: Editor;
  mixer: Mixer;
  recorder: Recorder;
  settings: OutputSettings;
  /** Relay-mode room (null when using the local server). */
  room: Room | null;
  saveSettings(): void;
  /** Add a video input to the scene being edited, sized to fit. */
  addInputItem(inputId: string): void;
}
