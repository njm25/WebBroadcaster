// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 publish/subscribe only).
// Used to pass encrypted signaling messages through public brokers.

const enc = new TextEncoder();
const dec = new TextDecoder();

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

function str(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function packet(header: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([new Uint8Array([header, ...varint(body.length)]), body]);
}

export type BrokerStatus = 'connecting' | 'open' | 'closed';

export class MqttBroker {
  status: BrokerStatus = 'closed';
  onStatus: (s: BrokerStatus) => void = () => {};
  onMessage: (topic: string, payload: Uint8Array) => void = () => {};

  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private stopped = true;
  private retry = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private packetId = 1;

  constructor(
    readonly url: string,
    private topic: string,
  ) {}

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array([0xe0, 0])); // DISCONNECT
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  publish(payload: Uint8Array): boolean {
    if (this.status !== 'open' || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(packet(0x30, concat([str(this.topic), payload])));
    return true;
  }

  private setStatus(s: BrokerStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private open() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    this.setStatus('connecting');
    const clientId = `wb${Math.random().toString(36).slice(2, 12)}`;

    ws.onopen = () => {
      // CONNECT: protocol "MQTT" level 4, clean session, keepalive 60s
      ws.send(packet(0x10, concat([str('MQTT'), new Uint8Array([4, 0x02, 0, 60]), str(clientId)])));
    };
    ws.onmessage = (ev) => {
      const chunk = new Uint8Array(ev.data as ArrayBuffer);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
      this.drain();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.setStatus(this.stopped ? 'closed' : 'connecting');
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0;
      let mult = 1;
      let i = 1;
      let byte: number;
      do {
        if (i >= this.buf.length) return;
        byte = this.buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;
      const header = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.slice(i + len);
      this.handle(header, body);
    }
  }

  private handle(header: number, body: Uint8Array) {
    const type = header >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) {
        this.ws?.close();
        return;
      }
      const id = this.packetId++ & 0xffff || 1;
      this.ws?.send(packet(0x82, concat([new Uint8Array([id >> 8, id & 0xff]), str(this.topic), new Uint8Array([0])])));
    } else if (type === 9) {
      // SUBACK
      this.retry = 0;
      this.setStatus('open');
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array([0xc0, 0]));
      }, 25000);
    } else if (type === 3) {
      // PUBLISH
      const qos = (header >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tlen));
      const payload = body.subarray(2 + tlen + (qos > 0 ? 2 : 0));
      this.onMessage(topic, payload);
    }
  }
}
