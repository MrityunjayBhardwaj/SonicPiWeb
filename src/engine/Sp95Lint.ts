/**
 * SP95-Loud — build-time detector for v1 limitations of the build-once-then-
 * interpret model (#350 + #351). These patterns produce SILENT failure today
 * (the SP95 churn-bomb); this module converts them into a visible warning so
 * the user sees "v1 doesn't support this — use X instead" instead of
 * mysterious silence.
 *
 * Three patterns. Each must distinguish itself from the *working* same-shape
 * idiom — false positives erode trust in the lint and would harm the gate
 * more than the silent failure does. Each detector is regex/scan-only over
 * the source string (no tree-sitter dependency) so it stays robust against
 * transpiler changes and runs in <1ms on any realistic snippet.
 *
 * **Pattern #350 — cross-loop set/get** (silent stale-read on the reader):
 *   `set :k, …` in `live_loop :A`, `get :k` in `live_loop :B`, A ≠ B.
 *   Same-loop set/get works (verified by r2_syncgate_crossset — must NOT warn).
 *
 * **Pattern #351-payload — cue payload via sync return-value** (silent drop):
 *   `cue :name, key: value` AND somewhere `sync :name` (or assigned and
 *   indexed), where the receiver tries to read the payload.
 *
 * **Pattern #351-index — bare sync-return-value indexed** (silent undefined):
 *   `e = sync :name` followed by `e[…]` or `e.something` — the value is the
 *   builder, indexing yields undefined which `play` no-ops.
 *
 * REFS: catalogue SP95 (parent), SV47 (NOT YET IMPLEMENTED), issues #350/#351,
 * dharana §B2 runtime-cluster co-gate per launch_acceptance_criteria.md.
 */

export interface Sp95Warning {
  // 'cross-loop-set-get' was retired 2026-05-28 once SV47 #350 became
  // IMPLEMENTED; #351 detectors remain.
  pattern: 'cue-payload-via-sync-return' | 'sync-return-indexed'
  title: string
  message: string
}

/**
 * Find `live_loop :name do … end` blocks and return [{name, body, line}].
 * Best-effort lexical scan — handles `live_loop :foo, sync: :bar do` (kwargs
 * before `do`) and `live_loop :foo do |i|` (block param). Doesn't parse
 * arbitrary nesting depth perfectly; balanced via a simple `do`/`end` counter
 * which is robust for the SP95 patterns we care about (top-level loops).
 */
function findLiveLoops(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  // Match `live_loop :NAME` (optionally followed by kwargs/whitespace, then `do`).
  // `:NAME` matches Ruby symbol; allow underscores and digits after the first char.
  const re = /\blive_loop\s+:([a-zA-Z_][a-zA-Z0-9_]*)\b[^\n]*?\bdo\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const bodyStart = m.index + m[0].length
    // Walk forward counting do/end to find this block's matching end.
    // Token-aware enough to skip `do` inside comments/strings: cheap heuristic —
    // strip line-comments and same-line string literals before counting.
    let depth = 1
    let i = bodyStart
    let bodyEnd = bodyStart
    while (i < src.length && depth > 0) {
      const nl = src.indexOf('\n', i)
      const lineEnd = nl === -1 ? src.length : nl
      const line = src.slice(i, lineEnd)
      const sanitized = line.replace(/#.*$/, '').replace(/'[^']*'|"[^"]*"/g, '""')
      const doCount = (sanitized.match(/\bdo\b/g) || []).length
      const endCount = (sanitized.match(/\bend\b/g) || []).length
      // Body includes the full line up to (but not past) the matching `end`.
      // For pattern detection we only care that set/get/cue tokens fall
      // inside; the closing `end` itself is harmless to include because it
      // doesn't match any of our token regexes.
      bodyEnd = lineEnd
      if (depth + doCount - endCount <= 0) break
      depth += doCount - endCount
      if (nl === -1) break
      i = nl + 1
    }
    out.push({ name, body: src.slice(bodyStart, bodyEnd) })
  }
  return out
}

/**
 * Pattern #350 cross-loop set/get — RETIRED 2026-05-28 (SV47 slice 2 / commit
 * 73a4475). The time-indexed Time State + eager b.set at build current_time() +
 * b.get vt-aware reader + post-sync iteration-vt bump together make the
 * director/section idiom read the cuer's same-vt value (desktop-matching
 * {55,59...} on r1). Warning here would be a SV50 false positive and erode the
 * lint's trust budget. The detector + its emitted warning are removed; the
 * negative-control assertion (now NO warn on the canonical pattern) is added
 * in Sp95Lint.test.ts. #351 detectors below are untouched — PLAN-d finalize
 * owns those.
 */

/**
 * Pattern #351-payload: `cue :name, key: value` with kwargs + a matching
 * `sync :name` somewhere. Payload is silently dropped by the build-once model.
 * Catches both `cue(:beat, val: x)` and `cue :beat, val: x`.
 */
function detectCuePayloadViaSync(src: string): Sp95Warning[] {
  // cue with kwargs: `cue :NAME` followed (allowing `(` or whitespace) by an
  // identifier-colon-space pattern indicating a kwarg, all on the same line.
  // Restrict to same-line so we don't accidentally pick up the next statement.
  const CUE_KW_RE = /\bcue\b\s*\(?\s*:([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:,|\)\s*,)\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:/g
  const cueNames = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = CUE_KW_RE.exec(src)) !== null) cueNames.add(m[1])
  if (cueNames.size === 0) return []
  // For each cue name with payload, is there a matching `sync :name`?
  const offenders: string[] = []
  for (const name of cueNames) {
    const SYNC_RE = new RegExp(`\\bsync\\b\\s*\\(?\\s*:${name}\\b`)
    if (SYNC_RE.test(src)) offenders.push(name)
  }
  if (offenders.length === 0) return []
  const list = offenders.map(n => `:${n}`).join(', ')
  return [{
    pattern: 'cue-payload-via-sync-return',
    title: 'cue payload via sync return-value is a v1 limitation (#351)',
    message: `Detected cue ${list} with keyword payload + a matching sync ${list}. The payload (val:, key:, etc.) is sent on the cue but NOT delivered through sync's return value in v1 — your receiver will read nil/undefined and play silently. Workaround: store the value via globalStore (set/get within the same loop, gated by sync) instead of attaching it to the cue. See SP95 / #351.`,
  }]
}

/**
 * Pattern #351-index: `e = sync :name` then `e[…]` or `e.field`.
 * Direct evidence the receiver expects payload. Catches the pattern even when
 * the corresponding `cue` is in another file or is missing kwargs entirely.
 */
function detectSyncReturnIndexed(src: string): Sp95Warning[] {
  // Match `e = sync :name` (or `e = sync(:name)`) where e is an identifier.
  const ASSIGN_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*sync\b\s*\(?\s*:([a-zA-Z_][a-zA-Z0-9_]*)\b/g
  const bindings: Array<{ varName: string; cueName: string; afterIndex: number }> = []
  let m: RegExpExecArray | null
  while ((m = ASSIGN_RE.exec(src)) !== null) {
    bindings.push({ varName: m[1], cueName: m[2], afterIndex: m.index + m[0].length })
  }
  if (bindings.length === 0) return []
  const offenderCues = new Set<string>()
  for (const b of bindings) {
    // Look for `e[…]` or `e.foo` AFTER the assignment. Bound the search to
    // ~2KB of following source to keep the regex linear and to avoid matching
    // unrelated variables of the same name in later code.
    const tail = src.slice(b.afterIndex, b.afterIndex + 2048)
    const INDEX_RE = new RegExp(`\\b${b.varName}\\s*\\[`)
    const DOT_RE = new RegExp(`\\b${b.varName}\\s*\\.\\s*[a-zA-Z_]`)
    if (INDEX_RE.test(tail) || DOT_RE.test(tail)) offenderCues.add(b.cueName)
  }
  if (offenderCues.size === 0) return []
  const list = [...offenderCues].map(n => `:${n}`).join(', ')
  return [{
    pattern: 'sync-return-indexed',
    title: 'Indexing the sync return-value yields undefined (#351)',
    message: `Detected the pattern: e = sync ${list} ... e[…] (or e.field). In v1, sync returns the builder itself, NOT the cue's payload — indexing it gives undefined and any play(undefined) is silently skipped. Workaround: don't rely on sync's return value; instead store the data via set in the cuer's loop and get it in the receiver after sync (same-loop set/get works inside a single loop; cross-loop is also a v1 limitation per #350). See SP95 / #351.`,
  }]
}

/**
 * Run all SP95-loud detectors over the given Ruby source. Returns an empty
 * list when no patterns match. Caller is responsible for surfacing the
 * warnings (per-evaluate dedup, formatting). Pure function — no IO.
 *
 * Total cost is one O(n) scan per detector; n ≪ 100KB for any realistic
 * Sonic Pi piece, so this runs in <1ms.
 */
export function detectSp95Limitations(src: string): Sp95Warning[] {
  // findLiveLoops kept for the future — only #351 detectors fire today
  // (#350 cross-loop set/get is now supported, see SV47 IMPLEMENTED).
  void findLiveLoops
  return [
    ...detectCuePayloadViaSync(src),
    ...detectSyncReturnIndexed(src),
  ]
}
