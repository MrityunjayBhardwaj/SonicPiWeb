/**
 * TimeState — a virtual-time-indexed key/value store for `set`/`get`.
 *
 * Mirrors Desktop Sonic Pi's Time State layer (`event_history.rb`): a `get`
 * resolves "the last seen version at or before the reader's time" (the
 * inclusive "last ≤ t" lookup, `event_history.rb:180`), and a `set` appends a
 * timestamped entry rather than blindly overwriting. Desktop has a dedicated
 * layer for this; per CLAUDE.md's "Architecture Principle" we mirror that
 * boundary in a single standalone module instead of scattering Map-of-arrays
 * logic across SonicPiEngine / ProgramBuilder / AudioInterpreter.
 *
 * Why time-indexed (SP95 / SV47 / #350): under the plain `Map` the apply moment
 * WAS the visibility moment, so a cross-loop `set`/`get` at the same virtual
 * time raced on microtask ordering. With a time index each `set` carries its
 * OWN recorded virtual time, so visibility is defined by the recorded TIMESTAMP,
 * not by the moment of application — eager build-time application no longer
 * collapses the intra-loop timeline the way SP41 feared (`set :x,1; sleep 2;
 * set :x,2` records x=1@T and x=2@(T+2); a reader at vt T+1 reads 1).
 *
 * v1 scope (Decision Q2/Q4): per-key append history without pruning (bounded by
 * run length, cleared only on dispose — SK14). No priority/thread fields; the
 * rare same-vt same-key two-writer case is resolved as last-write-wins (append
 * order among equal-t entries). The full desktop `(time, priority, thread_delta,
 * thread_id, beat, path)` total order is explicitly OUT of v1.
 */

interface TimeEntry {
  /** The virtual time (seconds) at which this value was written. */
  t: number
  value: unknown
}

export class TimeState {
  /**
   * Per-key time-ordered entries. Entries are kept in ascending `t` order; for
   * equal `t` the latest write is appended last (last-write-wins, Decision Q2).
   */
  private readonly store = new Map<string | symbol, TimeEntry[]>()

  /**
   * Append `{t, value}` for `key`.
   *
   * Idempotency requirement (Decision Q3): the interpreter's deferred `case
   * 'set'` may re-apply the SAME (key, value) at the SAME `t` that the eager
   * build-time write already recorded. A blind append would create a phantom
   * duplicate that could shadow the eager entry, so a re-application of the
   * identical (key, value, t) that is already the latest entry is a no-op —
   * guaranteeing "exactly one entry per (key, build-vt, value)".
   */
  set(key: string | symbol, value: unknown, t: number): void {
    const entries = this.store.get(key)
    if (!entries) {
      this.store.set(key, [{ t, value }])
      return
    }
    const last = entries[entries.length - 1]
    // Idempotent re-apply: identical (key, value, t) already the latest entry.
    if (last !== undefined && last.t === t && last.value === value) {
      return
    }
    // Maintain ascending-t order. The common case is an append (writes advance
    // monotonically with virtual time); a rare out-of-order write is inserted
    // at the correct position so the "last ≤ t" lookup stays correct.
    if (last === undefined || t >= last.t) {
      entries.push({ t, value })
      return
    }
    let i = entries.length
    while (i > 0 && entries[i - 1].t > t) i--
    entries.splice(i, 0, { t, value })
  }

  /**
   * Resolve the value of `key` at the reader's virtual time.
   *
   * - `get(key, t)` → value of the entry with the GREATEST `t` ≤ the argument
   *   `t` (INCLUSIVE — a set recorded at vt t IS visible to a get at vt t), or
   *   `null` if no entry is at or before `t` (matches the prior `?? null` at
   *   SonicPiEngine.ts:1060).
   * - `get(key)` (no `t`) → facade: the LATEST value (greatest t), or
   *   `undefined` if the key was never set (Map-compatible facade for tests).
   */
  get(key: string | symbol): unknown
  get(key: string | symbol, t: number): unknown
  get(key: string | symbol, t?: number): unknown {
    const entries = this.store.get(key)
    if (!entries || entries.length === 0) {
      // No-vt facade returns `undefined` (Map.get parity); vt-aware lookup
      // returns `null` to match the prior sandbox-get `?? null` behavior.
      return t === undefined ? undefined : null
    }
    if (t === undefined) {
      return entries[entries.length - 1].value
    }
    // Greatest entry with recorded vt ≤ t (inclusive). Linear scan from the end
    // is fine for v1's bounded histories; entries are ascending-t ordered.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].t <= t) return entries[i].value
    }
    return null
  }

  /** Number of distinct keys (facade for tests that read `.size`). */
  get size(): number {
    return this.store.size
  }

  /** Clear all entries. Dispose-only (SK14) — never on stop/run. */
  clear(): void {
    this.store.clear()
  }
}
