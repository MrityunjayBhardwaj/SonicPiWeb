/**
 * Audio recorder — captures AudioContext output to WAV.
 *
 * Taps the source AudioNode with a ScriptProcessor, accumulates raw float32
 * samples, and encodes a 16-bit PCM WAV on stop. No codec round-trip.
 *
 * Why not MediaRecorder + opus?
 *   The previous implementation used MediaStreamDestination + MediaRecorder
 *   (audio/webm;codecs=opus), then re-decoded to PCM. Opus is perceptually
 *   coded — transparent on stationary signals but distorts broadband transient
 *   content. Measured: HPF passband through opus loses ~63% of peak energy
 *   vs raw float32 from the same scsynth output. That gap propagated into
 *   every desktop-vs-web audio comparison and was misread as a mixer / FX-DSP
 *   parity gap. With a raw float32 tap, our recording_save WAV is the same
 *   PCM signal scsynth produced — apples-to-apples with desktop's recording_save.
 *
 * Why not SuperSonic.startCapture / stopCapture?
 *   SAB-mode-only. Our deploy serves without COOP/COEP headers (sonicpi.cc,
 *   the npm-published lib, sandboxed iframes), so SuperSonic boots in
 *   postMessage mode. ScriptProcessor works in both modes and gives us the
 *   same final-mix tap point we had before.
 *
 * Why ScriptProcessor (deprecated) instead of AudioWorkletNode?
 *   ScriptProcessor's pull-from-main-thread cost is irrelevant here — we tap
 *   the master output, which already exists, just to copy frames. No DSP
 *   work runs on main thread. Switching to a worklet would add a bundled
 *   processor file and a port-message protocol for chunk delivery; not worth
 *   it for read-only capture.
 */

const DEFAULT_CHANNELS = 2
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096

const WAV_HEADER_SIZE = 44
const WAV_FMT_CHUNK_SIZE = 16
const WAV_FMT_PCM = 1
const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = 2
const WAV_RIFF_DATA_OFFSET = 36
const INT16_NEGATIVE_SCALE = 0x8000
const INT16_POSITIVE_SCALE = 0x7FFF

export interface RecorderOptions {
  /** Sample rate (default: audioContext.sampleRate) */
  sampleRate?: number
  /** Number of channels (default: 2 for stereo) */
  channels?: number
}

type RecorderState = 'idle' | 'recording' | 'stopped'

export class Recorder {
  private audioCtx: AudioContext
  private source: AudioNode
  private channels: number
  /** Per-channel chunk lists. chunks[ch] is an array of Float32Array buffers. */
  private chunks: Float32Array[][] = []
  private processor: ScriptProcessorNode | null = null
  private silentSink: GainNode | null = null
  private _state: RecorderState = 'idle'

  constructor(audioCtx: AudioContext, source: AudioNode, options?: RecorderOptions) {
    this.audioCtx = audioCtx
    this.source = source
    this.channels = options?.channels ?? DEFAULT_CHANNELS
  }

  get state(): RecorderState {
    return this._state
  }

  /** Start recording. */
  start(): void {
    if (this._state === 'recording') return

    this.chunks = Array.from({ length: this.channels }, () => [])

    // ScriptProcessor must connect to a destination to actually run, but
    // we don't want it to play back into the speakers (the source already
    // routes there). Sink to a 0-gain node, then to destination — graph
    // runs but no audio is heard.
    this.processor = this.audioCtx.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      this.channels,
      this.channels,
    )
    const chunks = this.chunks
    const channels = this.channels
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer
      const numCh = Math.min(input.numberOfChannels, channels)
      for (let ch = 0; ch < numCh; ch++) {
        chunks[ch].push(new Float32Array(input.getChannelData(ch)))
      }
    }

    this.silentSink = this.audioCtx.createGain()
    this.silentSink.gain.value = 0
    this.source.connect(this.processor)
    this.processor.connect(this.silentSink)
    this.silentSink.connect(this.audioCtx.destination)

    this._state = 'recording'
  }

  /** Stop recording and return the audio as a WAV Blob. */
  async stop(): Promise<Blob> {
    if (this._state !== 'recording' || !this.processor) {
      throw new Error('Not recording')
    }

    // Pull one final scheduled callback to flush in-flight buffers, then
    // detach. ScriptProcessor delivers chunks on its own cadence; a single
    // microtask wait is enough to drain the last queued buffer.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    this.processor.onaudioprocess = null
    try { this.source.disconnect(this.processor) } catch { /* ok */ }
    try { this.processor.disconnect() } catch { /* ok */ }
    if (this.silentSink) {
      try { this.silentSink.disconnect() } catch { /* ok */ }
    }
    this.processor = null
    this.silentSink = null

    const wavBlob = this.encodeWav(this.chunks, this.audioCtx.sampleRate)
    this._state = 'stopped'
    return wavBlob
  }

  /** Stop recording and trigger a browser download. */
  async stopAndDownload(filename?: string): Promise<void> {
    const blob = await this.stop()
    Recorder.saveBlobToDownload(blob, filename)
  }

  /**
   * Trigger a browser download for an already-captured Blob.
   * Split out from stopAndDownload so the DSL `recording_save` step
   * can be invoked separately from `recording_stop` (#228).
   */
  static saveBlobToDownload(blob: Blob, filename?: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename ?? `sonicpi-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.wav`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Cancel recording without saving. */
  cancel(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null
      try { this.source.disconnect(this.processor) } catch { /* ok */ }
      try { this.processor.disconnect() } catch { /* ok */ }
    }
    if (this.silentSink) {
      try { this.silentSink.disconnect() } catch { /* ok */ }
    }
    this.processor = null
    this.silentSink = null
    this.chunks = []
    this._state = 'idle'
  }

  /** Build a 16-bit PCM WAV from per-channel float32 chunk lists. */
  private encodeWav(chunks: Float32Array[][], sampleRate: number): Blob {
    const numChannels = chunks.length
    const length = chunks[0]?.reduce((acc, c) => acc + c.length, 0) ?? 0
    const blockAlign = numChannels * BYTES_PER_SAMPLE
    const dataSize = length * blockAlign
    const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize)
    const view = new DataView(buffer)

    this.writeString(view, 0, 'RIFF')
    view.setUint32(4, WAV_RIFF_DATA_OFFSET + dataSize, true)
    this.writeString(view, 8, 'WAVE')
    this.writeString(view, 12, 'fmt ')
    view.setUint32(16, WAV_FMT_CHUNK_SIZE, true)
    view.setUint16(20, WAV_FMT_PCM, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, BITS_PER_SAMPLE, true)
    this.writeString(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    // Flatten per-channel chunk lists into contiguous Float32Array arrays.
    const channels: Float32Array[] = chunks.map((chs) => {
      const out = new Float32Array(length)
      let off = 0
      for (const c of chs) { out.set(c, off); off += c.length }
      return out
    })

    let offset = WAV_HEADER_SIZE
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]))
        view.setInt16(
          offset,
          sample < 0 ? sample * INT16_NEGATIVE_SCALE : sample * INT16_POSITIVE_SCALE,
          true,
        )
        offset += BYTES_PER_SAMPLE
      }
    }

    return new Blob([buffer], { type: 'audio/wav' })
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }
}
