import { WebSocket } from 'ws';

export class RealtimeSttClient {
  #ws = null;
  #config;
  #cid;
  #onSpeechStarted;
  #onTranscriptionCompleted;
  #onError;
  #closed = false;

  constructor({ config, cid, onSpeechStarted, onTranscriptionCompleted, onError }) {
    this.#config = config;
    this.#cid = cid;
    this.#onSpeechStarted = onSpeechStarted;
    this.#onTranscriptionCompleted = onTranscriptionCompleted;
    this.#onError = onError;
  }

  connect() {
    const { url, headers } = this.#buildConnection();
    console.log(`[rt ${this.#cid}] [stt] connecting to Realtime API: ${url.replace(/api-key=[^&]+/, 'api-key=***')}`);

    this.#ws = new WebSocket(url, { headers });

    this.#ws.on('open', () => {
      console.log(`[rt ${this.#cid}] [stt] WebSocket open — sending session.update`);
      this.#sendSessionUpdate();
    });

    this.#ws.on('message', (data) => {
      if (this.#closed) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.#handleEvent(msg);
    });

    this.#ws.on('error', (err) => {
      console.error(`[rt ${this.#cid}] [stt] WebSocket error:`, err.message);
      if (!this.#closed) this.#onError(err);
    });

    this.#ws.on('close', (code, reason) => {
      console.log(`[rt ${this.#cid}] [stt] WebSocket closed code=${code} reason="${reason?.toString() ?? ''}"`);
      if (!this.#closed) {
        this.#onError(new Error(`Realtime WS closed unexpectedly: ${code}`));
      }
    });
  }

  pushAudio(base64Pcm16) {
    if (this.#closed || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Pcm16,
    }));
  }

  close() {
    this.#closed = true;
    if (this.#ws) {
      try { this.#ws.close(); } catch (_) {}
      this.#ws = null;
    }
  }

  #buildConnection() {
    const rt = this.#config.realtime;
    if (rt.azureEndpoint && rt.azureKey && rt.azureDeployment) {
      const base = rt.azureEndpoint.replace(/\/$/, '');
      const url = `${base}/openai/realtime?api-version=2024-10-01-preview&deployment=${rt.azureDeployment}`;
      return { url: url.replace(/^https/, 'wss').replace(/^http/, 'ws'), headers: { 'api-key': rt.azureKey } };
    }
    const model = rt.openaiModel || 'gpt-4o-realtime-preview';
    return {
      url: `wss://api.openai.com/v1/realtime?model=${model}`,
      headers: { 'Authorization': `Bearer ${rt.openaiKey}`, 'OpenAI-Beta': 'realtime=v1' },
    };
  }

  #sendSessionUpdate() {
    this.#ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: '',
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: false,
        },
      },
    }));
  }

  #handleEvent(msg) {
    switch (msg.type) {
      case 'session.created':
        console.log(`[rt ${this.#cid}] [stt] session.created id=${msg.session?.id ?? '?'}`);
        break;
      case 'session.updated':
        console.log(`[rt ${this.#cid}] [stt] session.updated — ready`);
        break;
      case 'input_audio_buffer.speech_started':
        console.log(`[rt ${this.#cid}] [stt] speech_started`);
        this.#onSpeechStarted();
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log(`[rt ${this.#cid}] [stt] speech_stopped`);
        break;
      case 'input_audio_buffer.committed':
        console.log(`[rt ${this.#cid}] [stt] buffer committed item=${msg.item_id ?? '?'}`);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        console.log(`[rt ${this.#cid}] [stt] transcription: "${(msg.transcript ?? '').slice(0, 120)}"`);
        if (msg.transcript?.trim()) {
          this.#onTranscriptionCompleted(msg.transcript.trim());
        }
        break;
      case 'error':
        console.error(`[rt ${this.#cid}] [stt] API error:`, msg.error?.message ?? msg);
        this.#onError(new Error(msg.error?.message ?? 'Realtime API error'));
        break;
      default:
        break;
    }
  }
}
