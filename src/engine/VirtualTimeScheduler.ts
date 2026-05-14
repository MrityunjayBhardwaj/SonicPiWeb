import { MinHeap } from './MinHeap'

// ---------------------------------------------------------------------------
// Cue glob matching (#150) — supports * and ? wildcards in sync targets
// ---------------------------------------------------------------------------

/**
 * Match a sync pattern against a fired cue name.
 * Exact match is the fast path; glob matching activates only when the
 * pattern contains `*` or `?`.
 *
 * `*` matches any sequence of characters (including empty).
 * `?` matches exactly one character.
 *
 * Used by fireCue to wake sync waiters whose patterns glob-match the cue.
 */
function cueGlobMatch(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  // Convert glob to regex: escape special regex chars, then replace glob tokens
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(name)
}

// ---------------------------------------------------------------------------
// Scheduling constants
// ---------------------------------------------------------------------------

/**
 * How far ahead (seconds) events are submitted to the audio graph.
 *
 * Desktop Sonic Pi uses 0.5s. Events are scheduled via OSC bundles with NTP
 * timetags — the audio is sample-accurate regardless of schedAheadTime.
 * A larger value gives the scheduler more runway to process microtask work
 * from multiple concurrent loops without events arriving late.
 *
 * At 0.1s with 7 loops, tick + microtask work (~40ms) leaves only 60ms of
 * buffer — events barely make their window, causing audible drift (#71).
 * At 0.3s, the buffer is 260ms — comfortable even at high loop density.
 */
export const DEFAULT_SCHED_AHEAD_TIME = 0.3

/** Scheduler heartbeat interval in ms — 25ms = 40Hz. */
export const DEFAULT_TICK_INTERVAL_MS = 25

/**
 * Fallback BPM used by `fireCue` for synthetic external sources (`__midi__`,
 * `__osc__`) whose tasks aren't tracked. Matches `SonicPiEngine`'s startup
 * `defaultBpm = 60`. If you change one, change the other.
 */
export const DEFAULT_TASK_BPM = 60

/**
 * Tiebreak weight applied to insertion order when two sleep entries share the same
 * virtual time. 1e-12 s is far below any audio scheduling precision (≥1 ms), so it
 * never shifts actual timing — it only produces a deterministic total order in the heap.
 */
const HEAP_TIEBREAK_EPSILON = 1e-12

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SleepEntry {
  /** Virtual time to wake at (in seconds) */
  time: number
  /** Which task to resume */
  taskId: string
  /** Promise resolver — only tick() calls this (SV2) */
  resolve: () => void
  /** Insertion order for deterministic tiebreaking (#75 — avoids string allocation) */
  order: number
}

/**
 * Pending one-shot callback bound to audio time (SV41).
 *
 * Used by AudioInterpreter's reusableFx kill_delay — virtual-time-scheduled
 * kill so cancellation by next-iteration reuse is independent of real-time
 * iter pacing (SP87). Fired at `audioTime <= getAudioTime()` (no schedAhead),
 * which is one schedAhead behind sleep entries — this guarantees that when
 * an iter resumes via tick() and cancels its kill in its microtask, the
 * cancellation lands before the corresponding kill horizon is checked.
 */
interface PendingCallback {
  audioTime: number
  cb: () => void
  cancelled: boolean
}

export interface TaskState {
  id: string
  virtualTime: number
  bpm: number
  density: number
  currentSynth: string
  outBus: number
  /** The async loop body */
  asyncFn: () => Promise<void>
  /** Whether this task is actively running */
  running: boolean
}

export interface SchedulerEvent {
  type: 'synth' | 'sample' | 'control' | 'cue'
  taskId: string
  virtualTime: number
  audioTime: number
  params: Record<string, unknown>
}

export type EventHandler = (event: SchedulerEvent) => void

/**
 * Payload returned to a sync waiter when the cue fires (#236).
 * `bpm` carries the cuer's BPM at fire-time so waiters using `bpm_sync: true`
 * can inherit it (matches desktop `__change_spider_bpm_time_and_beat!`).
 *
 * Breaking change since v1.5.x: `waitForSync` previously returned
 * `Promise<unknown[]>`. External embedders calling `scheduler.waitForSync`
 * directly should migrate `args = await waitForSync(...)` to
 * `{ args } = await waitForSync(...)`.
 */
export interface SyncPayload {
  args: unknown[]
  bpm: number
}

export interface SchedulerOptions {
  /** AudioContext (or mock) for timing */
  getAudioTime?: () => number
  /** Lookahead in seconds (default: 0.1) */
  schedAheadTime?: number
  /** Tick interval in ms (default: 25) */
  tickInterval?: number
}

// ---------------------------------------------------------------------------
// VirtualTimeScheduler
// ---------------------------------------------------------------------------

/**
 * Cooperative async scheduler with virtual time.
 *
 * Core innovation: sleep() returns a Promise that ONLY tick() can resolve.
 * Multiple live_loops run concurrently via cooperative async suspension.
 *
 * Invariants:
 * - SV1: virtualTime per task is non-decreasing, advances only on sleep/sync
 * - SV2: sleep Promises are resolved exclusively by tick()
 * - SV3: deterministic ordering — entries sorted by (time, taskId)
 * - SV4: three-clock separation — wall/audio/virtual clocks are independent
 */
export class VirtualTimeScheduler {
  private queue: MinHeap<SleepEntry>
  private tasks = new Map<string, TaskState>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private getAudioTime: () => number
  /** Public read of the current audio-context time (used by current_time at top level — #226). */
  get audioTime(): number { return this.getAudioTime() }
  private schedAheadTime: number
  private tickInterval: number
  private eventHandlers: EventHandler[] = []
  private loopErrorHandler: ((taskId: string, err: Error) => void) | null = null
  /** Monotonic counter for deterministic ordering of same-time entries */
  private insertionOrder = 0
  /** Map from `${time}:${taskId}` to insertion order for stable sorting */
  // entryOrder Map removed — insertion order stored directly on SleepEntry (#75)
  private _running = false
  /** Cue state: last cue per name with virtual time, args, and cuer's BPM. */
  private cueMap = new Map<string, { time: number; args: unknown[]; bpm: number }>()
  /** Tasks waiting for a cue */
  private syncWaiters = new Map<string, Array<{
    taskId: string
    resolve: (payload: SyncPayload) => void
  }>>()
  /** One-shot audio-time-bound callbacks (SV41 — backs scheduleAtVirtualTime). */
  private pendingCallbacks: PendingCallback[] = []

  constructor(options: SchedulerOptions = {}) {
    this.getAudioTime = options.getAudioTime ?? (() => 0)
    this.schedAheadTime = options.schedAheadTime ?? DEFAULT_SCHED_AHEAD_TIME
    this.tickInterval = options.tickInterval ?? DEFAULT_TICK_INTERVAL_MS

    // Priority: by time, then by insertion order for determinism (SP1)
    // Uses entry.order directly — no Map lookup or string allocation (#75)
    this.queue = new MinHeap<SleepEntry>((entry) => {
      return entry.time + entry.order * HEAP_TIEBREAK_EPSILON
    })
  }

  get running(): boolean {
    return this._running
  }


  // ---------------------------------------------------------------------------
  // Task registration
  // ---------------------------------------------------------------------------

  /**
   * Register a named live_loop and immediately start its async chain.
   * The loop suspends at an initial sleep(0) — it won't execute until tick().
   */
  registerLoop(name: string, asyncFn: () => Promise<void>, options?: {
    bpm?: number
    synth?: string
    outBus?: number
  }): void {
    const existing = this.tasks.get(name)
    if (existing && existing.running) {
      // Hot-swap: replace the function, keep the virtual time (SV6)
      existing.asyncFn = asyncFn
      return
    }

    const task: TaskState = {
      id: name,
      virtualTime: this.getAudioTime(),
      bpm: options?.bpm ?? 60,
      density: 1,
      currentSynth: options?.synth ?? 'beep',
      outBus: options?.outBus ?? 0,
      asyncFn,
      running: true,
    }
    this.tasks.set(name, task)

    // Immediately start the async chain — it will suspend at sleep(0)
    this.runLoop(task)
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  /** Get names of all currently running loops. */
  getRunningLoopNames(): string[] {
    const names: string[] = []
    for (const [name, task] of this.tasks) {
      if (task.running) names.push(name)
    }
    return names
  }

  /** Stop a named loop from outside. Returns true if the loop was running. */
  stopLoop(name: string): boolean {
    const task = this.tasks.get(name)
    if (!task || !task.running) return false
    task.running = false
    return true
  }


  /**
   * Hot-swap a running loop's function.
   * Preserves virtualTime, bpm, density, random state (SV6).
   * The new function takes effect on the next loop iteration.
   */
  hotSwap(loopName: string, newFn: () => Promise<void>): boolean {
    const task = this.tasks.get(loopName)
    if (!task || !task.running) return false
    task.asyncFn = newFn
    return true
  }

  /**
   * Re-evaluate: given a new set of loop names and functions,
   * hot-swap loops that persist, stop removed loops, start new ones.
   */
  reEvaluate(loops: Map<string, () => Promise<void>>, options?: {
    bpm?: number
    synth?: string
  }): void {
    // Save previous state for rollback on failure
    const previousFns = new Map<string, () => Promise<void>>()
    const newlyStarted: string[] = []

    try {
      // Hot-swap or start loops
      for (const [name, fn] of loops) {
        const existing = this.tasks.get(name)
        if (existing && existing.running) {
          // Save previous function for rollback
          previousFns.set(name, existing.asyncFn)
          // Hot-swap: preserve virtual time (SV6)
          existing.asyncFn = fn
        } else {
          this.registerLoop(name, fn, options)
          newlyStarted.push(name)
        }
      }

      // Stop loops that are no longer present
      for (const [name, task] of this.tasks) {
        if (!loops.has(name) && task.running) {
          task.running = false
        }
      }
    } catch (err) {
      // Rollback: restore previous functions for swapped loops
      for (const [name, prevFn] of previousFns) {
        const task = this.tasks.get(name)
        if (task) task.asyncFn = prevFn
      }
      // Stop newly started loops
      for (const name of newlyStarted) {
        const task = this.tasks.get(name)
        if (task) task.running = false
      }
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // sleep — the core primitive
  // ---------------------------------------------------------------------------

  /**
   * Schedule a sleep for the given task.
   * Returns a Promise that ONLY tick() can resolve (SV2).
   *
   * Virtual time advances immediately on call (SV1).
   */
  scheduleSleep(taskId: string, beats: number): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return Promise.reject(new Error(`Unknown task: ${taskId}`))

    const seconds = (beats / task.bpm) * 60
    const wakeTime = task.virtualTime + seconds
    task.virtualTime = wakeTime

    return new Promise<void>((resolve) => {
      const order = this.insertionOrder++
      this.queue.push({ time: wakeTime, taskId, resolve, order })
    })
  }

  /**
   * Schedule a one-shot callback to fire when audio time reaches `audioTime` (SV41).
   *
   * Distinct from `scheduleSleep`:
   * - sleep entries fire at `audioTime + schedAhead >= entry.time` (lookahead horizon)
   * - pending callbacks fire at `audioTime >= entry.audioTime` (no lookahead)
   *
   * The schedAhead-stripped horizon is intentional: it gives a task that resumed
   * from a sleep firing in the same tick (lookahead horizon) time to drain its
   * microtask queue and call `.cancel()` before the corresponding callback's
   * horizon is checked. Used by `AudioInterpreter.reusableFx` to schedule
   * inner-FX kill_delay in virtual time instead of real-time setTimeout
   * (SP87, SV41 — iter pacing in real time is unstable post SV40 purge).
   *
   * Returns `{ cancel }` — call it to prevent the callback from firing.
   */
  scheduleAtVirtualTime(audioTime: number, cb: () => void): { cancel: () => void } {
    const entry: PendingCallback = { audioTime, cb, cancelled: false }
    this.pendingCallbacks.push(entry)
    return {
      cancel: () => { entry.cancelled = true },
    }
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler)
  }

  /** Register a handler called when a loop throws a runtime error. */
  onLoopError(handler: (taskId: string, err: Error) => void): void {
    this.loopErrorHandler = handler
  }

  emitEvent(event: SchedulerEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }

  // ---------------------------------------------------------------------------
  // sync/cue — inter-task synchronization
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a cue event. Any tasks waiting via waitForSync
   * are woken and inherit the cuer's virtual time (SV5).
   *
   * `taskId` may identify a real scheduler task (normal DSL cue from inside
   * a live_loop) OR a synthetic external source (e.g. `'__midi__'` from the
   * MIDI bridge, `'__osc__'` from incoming OSC — #151). When the task does
   * not exist, fall back to the current audio time so external sources still
   * wake sync waiters instead of silently returning.
   */
  fireCue(name: string, taskId: string, args: unknown[] = []): void {
    const task = this.tasks.get(taskId)
    const cueVirtualTime = task?.virtualTime ?? this.getAudioTime()
    // Synthetic external sources ('__midi__', '__osc__', #151) have no real
    // task — fall back to the engine's startup BPM so sync_bpm waiters still
    // get a defined value rather than NaN.
    const cueBpm = task?.bpm ?? DEFAULT_TASK_BPM

    this.cueMap.set(name, { time: cueVirtualTime, args, bpm: cueBpm })

    // Emit cue event for UI (CueLog panel)
    this.emitEvent({
      type: 'cue',
      taskId,
      virtualTime: cueVirtualTime,
      audioTime: this.getAudioTime(),
      params: { name, args },
    })

    // Wake any tasks waiting for this cue.
    // Supports exact match AND glob patterns (*, ?) in sync targets (#150).
    // Example: `sync "/midi:*:*/note_on"` matches a cue named `/midi:*:1/note_on`.
    for (const [pattern, waiters] of this.syncWaiters) {
      if (waiters.length === 0) continue
      if (!cueGlobMatch(pattern, name)) continue
      for (const waiter of waiters) {
        const waiterTask = this.tasks.get(waiter.taskId)
        if (waiterTask) {
          // Inherit cue's virtual time (SV5)
          waiterTask.virtualTime = cueVirtualTime
        }
        waiter.resolve({ args, bpm: cueBpm })
      }
      this.syncWaiters.delete(pattern)
    }
  }

  /**
   * Wait for a cue. The calling task suspends until fireCue(name) is called.
   * On resume, the task inherits the cue's virtual time (SV5). The resolved
   * payload also carries the cuer's BPM so callers using `bpm_sync: true`
   * (sync_bpm, #236) can mutate the waiter's task.bpm.
   */
  waitForSync(name: string, taskId: string): Promise<SyncPayload> {
    // Always wait for a FRESH cue — never resolve from stale cueMap entries.
    // In Sonic Pi, sync(:name) parks the thread until a NEW cue fires.
    // get(:name) returns existing values; sync waits for the next one.
    // Without this, loops synced to met1 start at vt=0 instead of waiting
    // for met1's first beat (met1's auto-cue fires before synced loops run).
    return new Promise<SyncPayload>((resolve) => {
      const waiters = this.syncWaiters.get(name) ?? []
      waiters.push({ taskId, resolve })
      this.syncWaiters.set(name, waiters)
    })
  }

  // ---------------------------------------------------------------------------
  // Tick — the scheduler heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Resolve all sleep entries up to targetTime.
   * Entries are resolved in deterministic order (time, then insertion order).
   *
   * With 10ms tick interval + 300ms schedAheadTime (#71), events are resolved
   * more frequently (100Hz vs 40Hz) and have 3x more runway before their
   * target audio time, reducing the impact of microtask processing delays.
   */
  tick(targetTime?: number): void {
    const target = targetTime ?? (this.getAudioTime() + this.schedAheadTime)

    while (this.queue.peek() && this.queue.peek()!.time <= target) {
      const entry = this.queue.pop()!
      entry.resolve()
    }

    // SV41: fire/cleanup pending audio-time-bound callbacks AFTER sleep entries.
    // Horizon is `target - schedAhead` (the underlying audio time), so any task
    // resumed from the sleep heap above has a chance to drain its microtask
    // queue and cancel its kill before the kill's horizon is reached.
    //
    // CRITICAL: fired callbacks are deferred via `queueMicrotask`. Sleep entries
    // resolved above queued their await-resumption microtasks FIRST; deferring
    // the kill fire ensures an iter that resumes from sleep and synchronously
    // cancels its kill in a with_fx reuse-check lands BEFORE the kill wrapper
    // checks `cancelled`. Without the deferral, kill fires synchronously inside
    // tick() (before any microtask drain), so when the same tick resolves both
    // iter N+1's sleep and the kill horizon, the kill executes before iter N+1
    // can call .cancel() — and the FX is wrongly freed (SP87).
    if (this.pendingCallbacks.length > 0) {
      const cbHorizon = target - this.schedAheadTime
      let writeIdx = 0
      for (let i = 0; i < this.pendingCallbacks.length; i++) {
        const pc = this.pendingCallbacks[i]
        if (pc.cancelled) continue // drop cancelled
        if (pc.audioTime <= cbHorizon) {
          const fired = pc
          queueMicrotask(() => {
            if (fired.cancelled) return
            try { fired.cb() } catch (err) {
              if (this.loopErrorHandler) this.loopErrorHandler('__pendingCallback__', err as Error)
            }
          })
          continue // drop fired (queued)
        }
        this.pendingCallbacks[writeIdx++] = pc
      }
      this.pendingCallbacks.length = writeIdx
    }
  }

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  /** Start the tick timer. Loops are already running (suspended at sleep). */
  start(): void {
    if (this._running) return
    this._running = true
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval)
  }

  /** Pause the tick timer without stopping tasks. Used during hot-swap. */
  pauseTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /** Resume the tick timer after a pause. */
  resumeTick(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    if (!this._running) { this.tickTimer = null; return }
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval)
  }

  stop(): void {
    this._running = false

    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }

    // Mark all tasks as not running — breaks their while loops
    for (const task of this.tasks.values()) {
      task.running = false
    }
  }

  dispose(): void {
    this.stop()
    this.tasks.clear()
    this.queue.clear()
    this.eventHandlers.length = 0
    this.cueMap.clear()
    this.syncWaiters.clear()
    this.pendingCallbacks.length = 0
  }

  // ---------------------------------------------------------------------------
  // Internal: loop execution
  // ---------------------------------------------------------------------------

  private async runLoop(task: TaskState): Promise<void> {
    // Initial sleep(0) so the loop doesn't start until tick fires
    await this.scheduleSleep(task.id, 0)

    // No-sleep iteration counter — detects live_loops that forgot sleep.
    // Each iteration that completes without advancing virtual time increments this.
    // After MAX_NOSLEEP_ITERATIONS, the loop is killed with InfiniteLoopError.
    // A successful sleep resets the counter. Matches Desktop SP's "did you forget a sleep?" error.
    const MAX_NOSLEEP_ITERATIONS = 1024
    let noSleepCount = 0

    while (task.running) {
      // Auto-cue: Sonic Pi fires cue(:loop_name) at the start of each iteration.
      // This is how sync: :name works on other live_loops.
      // Note: SonicPiEngine also fires a cue after each iteration (line ~290).
      // Having it here ensures it works for raw scheduler usage too.
      this.fireCue(task.id, task.id)
      const vtBefore = task.virtualTime
      try {
        await task.asyncFn()
      } catch (err) {
        // StopSignal is expected — it means `stop` was called in user code
        if (err instanceof Error && err.name === 'StopSignal') {
          task.running = false
          break
        }
        // InfiniteLoopError — stop the loop immediately, do not retry
        if (err instanceof Error && err.name === 'InfiniteLoopError') {
          task.running = false
          if (this.loopErrorHandler) {
            this.loopErrorHandler(task.id, err)
          } else {
            console.error(`[SonicPi] Error in loop "${task.id}":`, err)
          }
          break
        }
        const error = err instanceof Error ? err : new Error(String(err))
        if (this.loopErrorHandler) {
          this.loopErrorHandler(task.id, error)
        } else {
          console.error(`[SonicPi] Error in loop "${task.id}":`, error)
        }
        // Recovery sleep: pause 1 beat so we don't spin on a tight error loop
        if (task.running) {
          await this.scheduleSleep(task.id, 1)
        }
      }

      // No-sleep detection: if virtual time didn't advance, the loop body
      // had no sleep/sync. After MAX_NOSLEEP_ITERATIONS, kill the loop.
      // This prevents browser tab freeze from `live_loop :x do; play 60; end`.
      if (task.virtualTime === vtBefore) {
        noSleepCount++
        if (noSleepCount >= MAX_NOSLEEP_ITERATIONS) {
          const err = new Error('Infinite loop detected — did you forget a sleep?')
          err.name = 'InfiniteLoopError'
          task.running = false
          if (this.loopErrorHandler) {
            this.loopErrorHandler(task.id, err)
          } else {
            console.error(`[SonicPi] Error in loop "${task.id}":`, err)
          }
          break
        }
      } else {
        noSleepCount = 0
      }
    }
  }
}
