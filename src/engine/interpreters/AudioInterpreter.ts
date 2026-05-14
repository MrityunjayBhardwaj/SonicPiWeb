/**
 * AudioInterpreter — runs a Program against real audio.
 *
 * The only interpreter that touches SuperSonic and the scheduler.
 * Walks the step array, triggers synths/samples, awaits sleep via
 * the VirtualTimeScheduler.
 */

import type { Program } from '../Program'
import { normalizePlayParams, normalizeControlParams, normalizeFxParams, resolveSynthName } from '../SoundLayer'
import { noteToMidi } from '../NoteToFreq'

/** Visual duration used for note events in the sound event stream (seconds). */
const NOTE_EVENT_VISUAL_DURATION = 0.25
/** Visual duration used for sample events in the sound event stream (seconds). */
const SAMPLE_EVENT_VISUAL_DURATION = 0.5
import type { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import type { SuperSonicBridge } from '../SuperSonicBridge'
import type { SoundEventStream, SoundEvent } from '../SoundEventStream'
import type { MidiBridge } from '../MidiBridge'

/** State for a reusable inner FX node (persists across loop iterations). */
interface ReusableFxState {
  bus: number
  groupId: number
  nodeId: number
  outBus: number
  /**
   * Pending kill_delay handle — cancelled if FX is reused before it fires (SV41).
   * Backed by `scheduler.scheduleAtVirtualTime` (audio-time scheduled) instead
   * of `setTimeout` (real-time scheduled) so cancellation is independent of
   * real-time iter pacing (SP87 — post-purge real-time-paced iterations broke
   * the setTimeout-based reuse logic).
   */
  killTimer?: { cancel: () => void }
}

export interface AudioContext {
  bridge: SuperSonicBridge | null
  scheduler: VirtualTimeScheduler
  taskId: string
  eventStream: SoundEventStream
  schedAheadTime: number
  printHandler?: (msg: string) => void
  nodeRefMap: Map<number, number>
  /**
   * Reusable inner FX nodes — keyed by "taskId:fxIndex".
   * with_fx inside a live_loop reuses the same FX node across iterations
   * instead of creating a new one each time. This prevents additive signal
   * stacking from overlapping echo/delay/reverb nodes. See issue #70.
   */
  reusableFx: Map<string, ReusableFxState>
  /** Global store for set/get — deferred set steps write here at runtime. */
  globalStore?: Map<string | symbol, unknown>
  /** Host-provided OSC send handler. If not set, osc_send is a silent no-op. */
  oscHandler?: (host: string, port: number, path: string, ...args: unknown[]) => void
  /** MIDI bridge for deferred midi-out steps (issue #195). */
  midiBridge?: MidiBridge
  /**
   * Volume-change callback (issue #201). Deferred `set_volume` steps fire at
   * scheduled time and need to update the engine's closure-local
   * `currentVolume` so the next iteration's `current_volume` returns the
   * new value. The engine wires this to its setVolumeShared closure;
   * unset means: just push the bridge change (legacy path).
   */
  onVolumeChange?: (vol: number) => void
  /**
   * Recording lifecycle callback (#228). Fires at scheduled virtual time
   * for `recordingStart` / `recordingStop` / `recordingSave` /
   * `recordingDelete` steps. Engine-side state machine (Recorder instance,
   * lastRecording Blob) lives in SonicPiEngine; this callback is the
   * narrow seam through which the interpreter mutates it. Unset = no-op
   * (e.g. tests with no Recorder host).
   */
  onRecordingEvent?: (
    kind: 'start' | 'stop' | 'save' | 'delete',
    filename?: string,
  ) => void | Promise<void>
}

/**
 * Run a Program's steps for one loop iteration.
 * Called by the scheduler's loop runner.
 *
 * fxCounter tracks the Nth FX step encountered in this iteration, used as a
 * stable key to reuse inner FX nodes across iterations. The program structure
 * is identical each iteration (same builder), so the Nth FX always corresponds
 * to the same with_fx block.
 */
export async function runProgram(
  program: Program,
  ctx: AudioContext,
  fxCounter?: { value: number },
): Promise<void> {
  if (!fxCounter) fxCounter = { value: 0 }
  let currentSynth = 'beep'
  let currentBpm = ctx.scheduler.getTask(ctx.taskId)?.bpm ?? 60
  let nextNodeRef = 1

  for (const step of program) {
    const task = ctx.scheduler.getTask(ctx.taskId)
    if (!task?.running) break

    switch (step.tag) {
      case 'play': {
        // Sonic Pi's should_trigger?: skip if on: is present and falsy
        if ('on' in step.opts && !step.opts.on) break

        const audioTime = task.virtualTime + ctx.schedAheadTime
        const synth = resolveSynthName(step.synth ?? currentSynth)
        const nodeRef = nextNodeRef++

        if (ctx.bridge) {
          // Auto-start mic input on the FIRST dispatch of sound_in per run (#152).
          // The live_loop re-dispatches every ~100ms; without this gate the mic
          // would churn (stop → getUserMedia → reconnect) 10×/sec and the
          // browser's recording indicator would flicker. The bridge is already
          // idempotent + race-safe, but the cheap sync check here also avoids
          // spamming "Mic input failed" from the .catch on every dispatch.
          if ((synth === 'sound_in' || synth === 'sound_in_stereo') &&
              !ctx.bridge.isLiveAudioStreaming(synth)) {
            ctx.bridge.startLiveAudio(synth, { stereo: synth === 'sound_in_stereo' })
              .catch((err: Error) => ctx.printHandler?.(`Mic input failed: ${err.message}`))
          }

          // Mutate step.opts directly — normalizePlayParams copies internally.
          // Avoids 3 object spreads per event that cause GC pressure (#75).
          step.opts.note = step.note
          const playWarn = ctx.printHandler
            ? (m: string) => ctx.printHandler!(`[Warning] play :${synth} — ${m}`)
            : undefined
          const params = normalizePlayParams(synth, step.opts, currentBpm, playWarn)
          params.out_bus = task.outBus
          ctx.bridge.triggerSynth(synth, audioTime, params)
            .then(realNodeId => ctx.nodeRefMap.set(nodeRef, realNodeId))
            .catch((err: Error) => {
              ctx.printHandler?.(`Synth '${synth}' failed: ${err.message}`)
            })
        }

        // Emit sound event
        const audioCtxTime = ctx.bridge?.audioContext?.currentTime ?? 0
        ctx.eventStream.emitEvent({
          audioTime,
          audioDuration: NOTE_EVENT_VISUAL_DURATION,
          scheduledAheadMs: (audioTime - audioCtxTime) * 1000,
          midiNote: step.note,
          s: synth,
          srcLine: step.srcLine ?? null,
          trackId: ctx.taskId,
        })
        break
      }

      case 'sample': {
        // Sonic Pi's should_trigger?: skip if on: is present and falsy
        if (step.opts && 'on' in step.opts && !step.opts.on) break

        const audioTime = task.virtualTime + ctx.schedAheadTime
        if (ctx.bridge) {
          // Merge out_bus from task — samples inside with_fx must write to the FX bus,
          // not the default bus 0. Without this, samples bypass FX entirely.
          const sampleOpts = task.outBus !== 0
            ? { ...step.opts, out_bus: task.outBus }
            : step.opts
          ctx.bridge.playSample(step.name, audioTime, sampleOpts, currentBpm)
            .catch((err: Error) => {
              ctx.printHandler?.(`Sample '${step.name}' failed: ${err.message}`)
            })
        }

        const audioCtxTime = ctx.bridge?.audioContext?.currentTime ?? 0
        ctx.eventStream.emitEvent({
          audioTime,
          audioDuration: SAMPLE_EVENT_VISUAL_DURATION,
          scheduledAheadMs: (audioTime - audioCtxTime) * 1000,
          midiNote: null,
          s: step.name,
          srcLine: step.srcLine ?? null,
          trackId: ctx.taskId,
        })
        break
      }

      case 'sleep':
        // Flush queued OSC messages BEFORE sleeping — matches Sonic Pi's
        // __schedule_delayed_blocks_and_messages! All events since last
        // sleep share one NTP timetag in a single OSC bundle.
        ctx.bridge?.flushMessages()
        await ctx.scheduler.scheduleSleep(ctx.taskId, step.beats)
        break

      case 'useSynth':
        currentSynth = resolveSynthName(step.name)
        if (task) task.currentSynth = currentSynth
        break

      case 'useBpm':
        currentBpm = step.bpm
        if (task) task.bpm = step.bpm
        break

      case 'useRealTime':
        // Set schedule-ahead to 0 for responsive MIDI input (#149).
        // Desktop SP Ch 11.1: use_real_time disables latency for current thread.
        ctx.schedAheadTime = 0
        break

      case 'control': {
        const realNodeId = ctx.nodeRefMap.get(step.nodeRef)
        if (realNodeId && ctx.bridge) {
          const audioTime = task.virtualTime + ctx.schedAheadTime
          const ctlWarn = ctx.printHandler
            ? (m: string) => ctx.printHandler!(`[Warning] control — ${m}`)
            : undefined
          const normalized = normalizeControlParams(step.params, currentBpm, ctlWarn)
          const paramList: (string | number)[] = []
          for (const [k, v] of Object.entries(normalized)) {
            paramList.push(k, v)
          }
          ctx.bridge.sendTimedControl(audioTime, realNodeId, paramList)
        }
        break
      }

      case 'kill': {
        const killNodeId = ctx.nodeRefMap.get(step.nodeRef)
        if (killNodeId && ctx.bridge) {
          ctx.bridge.freeNode(killNodeId)
        }
        break
      }

      case 'cue':
        ctx.scheduler.fireCue(step.name, ctx.taskId, step.args ?? [])
        break

      case 'set':
        // Deferred set — fires at runtime, interleaved with sleeps
        if (ctx.globalStore) {
          ctx.globalStore.set(step.key, step.value)
        }
        break

      case 'sync': {
        ctx.bridge?.flushMessages()
        const payload = await ctx.scheduler.waitForSync(step.name, ctx.taskId)
        if (step.bpmSync) {
          // Inherit cuer's BPM (sync_bpm, #236). Mutate both runtime locals
          // so subsequent sleep/play/FX steps in this iteration use the
          // new BPM. Matches desktop `__change_spider_bpm_time_and_beat!`.
          currentBpm = payload.bpm
          if (task) task.bpm = payload.bpm
        }
        break
      }

      case 'fx': {
        const reps = (step.opts.reps as number) ?? 1
        if (!ctx.bridge) {
          // No audio — just run inner program
          for (let rep = 0; rep < reps; rep++) await runProgram(step.body, ctx, fxCounter)
          break
        }
        const fxIndex = fxCounter.value++
        const fxKey = `${ctx.taskId}:fx${fxIndex}`
        const prevOutBus = task.outBus

        // Reuse FX node across loop iterations (issue #70).
        // First iteration: create FX node + bus, store in reusableFx map.
        // Subsequent iterations: reuse the same node — inner synths write
        // to the same bus, FX processes a continuous stream.
        // This prevents additive signal stacking from overlapping echo nodes.
        const existing = ctx.reusableFx.get(fxKey)
        if (existing) {
          // Reuse — cancel pending kill timer, route through existing FX bus
          if (existing.killTimer) {
            existing.killTimer.cancel()
            existing.killTimer = undefined
          }
          if (step.nodeRef && existing.nodeId !== undefined) {
            ctx.nodeRefMap.set(step.nodeRef, existing.nodeId)
          }
          task.outBus = existing.bus
          try {
            for (let rep = 0; rep < reps; rep++) await runProgram(step.body, ctx, fxCounter)
          } finally {
            task.outBus = prevOutBus
            ctx.bridge.flushMessages()
            // Schedule kill in VIRTUAL TIME (SV41) — cancelled if next iter
            // reuses before its horizon. setTimeout-based (real-time) scheduling
            // raced post-SV40-purge real-time-paced iterations (SP87).
            //
            // GUARD: only schedule if our `existing` state is STILL the active
            // entry in the Map. After SonicPiEngine's hot-swap reusableFx.clear,
            // this iter's `existing` reference becomes stale (resources already
            // freed by clear); a scheduled kill would (a) leak an uncancellable
            // callback and (b) eventually run /n_free + freeBus on the freed
            // (and possibly re-allocated) resources. The next iter will hit
            // CREATE branch and own the new state's killTimer.
            if (ctx.reusableFx.get(fxKey) === existing) {
              const killDelay = (step.opts.kill_delay as number) ?? 1.0
              const killAt = task.virtualTime + killDelay
              existing.killTimer = ctx.scheduler.scheduleAtVirtualTime(killAt, () => {
                // /n_free the FX synth itself — applyFxImmediate puts it in
                // root group 101 (not the container group), so freeGroup
                // alone leaves the synth running and ringing into outer FX.
                ctx.bridge!.freeNode(existing.nodeId)
                ctx.bridge!.freeGroup(existing.groupId)
                ctx.bridge!.freeBus(existing.bus)
                ctx.reusableFx.delete(fxKey)
              })
            }
          }
        } else {
          // First iteration — create FX node
          const newBus = ctx.bridge.allocateBus()
          const fxGroupId = ctx.bridge.createFxGroup()
          let fxNodeId: number | undefined
          try {
            const audioTime = task.virtualTime + ctx.schedAheadTime
            const fxWarn = ctx.printHandler
              ? (m: string) => ctx.printHandler!(`[Warning] with_fx :${step.name} — ${m}`)
              : undefined
            const fxOpts = normalizeFxParams(step.name, step.opts, currentBpm, fxWarn)
            fxNodeId = await ctx.bridge.applyFx(step.name, audioTime, fxOpts, newBus, prevOutBus)
            if (step.nodeRef && fxNodeId !== undefined) {
              ctx.nodeRefMap.set(step.nodeRef, fxNodeId)
            }
            task.outBus = newBus
            ctx.bridge.flushMessages()
            // Store for reuse — with pending kill timer as safety net
            const state: ReusableFxState = {
              bus: newBus,
              groupId: fxGroupId,
              nodeId: fxNodeId!,
              outBus: prevOutBus,
            }
            ctx.reusableFx.set(fxKey, state)
            for (let rep = 0; rep < reps; rep++) await runProgram(step.body, ctx, fxCounter)
          } finally {
            task.outBus = prevOutBus
            ctx.bridge.flushMessages()
            // Schedule kill in VIRTUAL TIME (SV41) — if next iter reuses, cancelled
            const killDelay = (step.opts.kill_delay as number) ?? 1.0
            const state = ctx.reusableFx.get(fxKey)
            if (state) {
              const killAt = task.virtualTime + killDelay
              state.killTimer = ctx.scheduler.scheduleAtVirtualTime(killAt, () => {
                ctx.bridge!.freeNode(state.nodeId)
                ctx.bridge!.freeGroup(state.groupId)
                ctx.bridge!.freeBus(state.bus)
                ctx.reusableFx.delete(fxKey)
              })
            }
          }
        }
        break
      }

      case 'thread': {
        const task = ctx.scheduler.getTask(ctx.taskId)
        if (!task) break
        const threadName = `${ctx.taskId}__thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const threadBody = step.body

        // Spawn a one-shot "loop" that runs the thread body once, then stops
        ctx.scheduler.registerLoop(threadName, async () => {
          await runProgram(threadBody, {
            ...ctx,
            taskId: threadName,
          })
          // One-shot: stop after first run
          const t = ctx.scheduler.getTask(threadName)
          if (t) t.running = false
        }, {
          bpm: task.bpm,
          synth: task.currentSynth,
          outBus: task.outBus,
        })
        break
      }

      case 'liveAudio': {
        if (ctx.bridge) {
          if (step.stop) {
            // live_audio :name, :stop (#236) — kill the named live audio.
            // Synchronous; mirrors hot-swap reconciliation at SonicPiEngine.ts:309.
            ctx.bridge.stopLiveAudio(step.name)
          } else {
            ctx.bridge.startLiveAudio(step.name, { stereo: !!step.opts.stereo })
              .catch((err: Error) => ctx.printHandler?.(`live_audio failed: ${err.message}`))
          }
        }
        break
      }

      case 'oscSend':
        if (ctx.oscHandler) {
          ctx.oscHandler(step.host, step.port, step.path, ...step.args)
        } else {
          ctx.printHandler?.(`[Warning] osc_send: no handler set — message to ${step.host}:${step.port}${step.path} dropped`)
        }
        break

      case 'print':
        ctx.printHandler?.(step.message)
        break

      case 'stop':
        ctx.bridge?.flushMessages()
        if (task) task.running = false
        return

      // --- Deferred-step DSL fixes (issue #193) ---

      case 'stopLoop':
        // Stop a named live_loop at the scheduled time (#194). Without this,
        // stop_loop fired at BUILD time, killing target loops at beat 0.
        ctx.scheduler.stopLoop(step.name)
        break

      case 'setVolume': {
        // Master-volume change at the scheduled time (#197). Ducking patterns
        // were broken because both calls fired at beat 0; now the second call
        // happens after the intermediate sleep.
        // Route through onVolumeChange (#201) so the engine's closure-local
        // currentVolume — read by current_volume — is also updated. Without
        // this, `set_volume 0.3; sleep 4; puts current_volume` printed 1.0.
        const vol = Math.max(0, Math.min(5, step.vol))
        if (ctx.onVolumeChange) {
          ctx.onVolumeChange(vol)
        } else {
          ctx.bridge?.setMasterVolume(vol / 5)
        }
        break
      }

      case 'setMixerControl':
        // Mixer-param sweep at the scheduled time (#255). Same lifecycle
        // reasoning as setVolume: top-level immediate would collapse a
        // `set_mixer_control! lpf: 30; sleep 4; reset_mixer!` pair to two
        // calls at beat 0.
        ctx.bridge?.setMixerControl(step.opts)
        break

      case 'resetMixer':
        // Restore the MIXER config defaults (#255).
        ctx.bridge?.resetMixer()
        break

      case 'useOsc':
        // Mutates builder defaults at build; this step is here so the change
        // is also visible to a step-time observer (no-op effect on bridge,
        // but keeps the lifecycle parity-correct against desktop SP).
        break

      case 'recordingStart':
        await ctx.onRecordingEvent?.('start')
        break

      case 'recordingStop':
        // Await so recording_save in the next step sees lastRecording set.
        // The engine's stop() handler returns a Promise that resolves once
        // MediaRecorder.onstop has fired and the WAV re-encode finishes.
        await ctx.onRecordingEvent?.('stop')
        break

      case 'recordingSave':
        await ctx.onRecordingEvent?.('save', step.filename)
        break

      case 'recordingDelete':
        await ctx.onRecordingEvent?.('delete')
        break

      case 'midiOut': {
        // 14 MIDI-output entry points (#195). All routed through one tag
        // with a `kind` discriminator. Without these, every midi_* call
        // inside a live_loop fired at beat 0 — scheduled MIDI was broken.
        const mb = ctx.midiBridge
        if (!mb) break
        const a = step.args as unknown[]
        switch (step.kind) {
          case 'noteOn': {
            const [note, vel, ch] = a as [number | string, number, number]
            const n = typeof note === 'string' ? noteToMidi(note) : note
            mb.noteOn(n, vel, ch)
            break
          }
          case 'noteOff': {
            const [note, ch, sustainBeats] = a as [number | string, number, number]
            const n = typeof note === 'string' ? noteToMidi(note) : note
            if (sustainBeats > 0) {
              // BPM-aware delay tracked by MidiBridge so engine.stop() can
              // cancel-and-fire-now to prevent hung notes on the device (#200).
              const seconds = sustainBeats * 60 / currentBpm
              mb.scheduleNoteOff(n, ch, seconds)
            } else {
              mb.noteOff(n, ch)
            }
            break
          }
          case 'cc':              { const [c, v, ch] = a as [number, number, number]; mb.cc(c, v, ch); break }
          case 'pitchBend':       { const [v, ch] = a as [number, number]; mb.pitchBend(v, ch); break }
          case 'channelPressure': { const [v, ch] = a as [number, number]; mb.channelPressure(v, ch); break }
          case 'polyPressure':    { const [n, v, ch] = a as [number, number, number]; mb.polyPressure(n, v, ch); break }
          case 'progChange':      { const [p, ch] = a as [number, number]; mb.programChange(p, ch); break }
          case 'clockTick':       mb.clockTick(); break
          case 'start':           mb.midiStart(); break
          case 'stop':            mb.midiStop(); break
          case 'continue':        mb.midiContinue(); break
          case 'allNotesOff':     { const [ch] = a as [number]; mb.allNotesOff(ch); break }
        }
        break
      }
    }
  }
  // Flush any remaining queued messages at end of program
  ctx.bridge?.flushMessages()
}

