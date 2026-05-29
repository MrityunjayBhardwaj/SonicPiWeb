/**
 * Raw UGen test — the SP108 decisive fork (issue #417).
 *
 * Hand-builds minimal SCgf v1 synthdefs that contain ONLY one oscillator ugen
 * (no LPF, no Normalizer, no envelope), sends them to the live WASM scsynth via
 * raw /d_recv + /s_new through the SAME routing real synths use (group 100 →
 * bus 0 → mixer → output), and records each via a masterOutputNode tap.
 *
 * This isolates the oscillator ugen from the `sonic-pi-saw` synthdef chain:
 *   rawsaw = Out.ar(0, Saw.ar(220) * 0.3)      ← no LPF/Normalizer
 *   rawsin = Out.ar(0, SinOsc.ar(220) * 0.3)   ← control (known-good)
 *   rawpulse = Out.ar(0, Pulse.ar(220,0.5) * 0.3)
 *
 * If rawsaw renders as a sine (crest ≈ 1.414, single peak) → the WASM `Saw`
 * ugen itself is broken (upstream / core build). If rawsaw shows the 1/n
 * harmonic series → the culprit is downstream in sonic-pi-saw (LPF/Normalizer).
 *
 * SCgf v1 encoder mirrors src/engine/buildTrackMonitorSynthDef.ts.
 * Browser plumbing mirrors tools/capture.ts.
 *
 * Usage: npx tsx tools/raw-ugen-test.ts
 */

import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/sp108-raw-ugen'
const REC_MS = 2500

// ── SCgf v1 encoder ──────────────────────────────────────────────────────
const R_SCALAR = 0, R_CONTROL = 1, R_AUDIO = 2
const BINOP_MUL = 2

interface UGen {
  name: string
  rate: number
  inputs: Array<[number, number]> // [ugenIdx, outIdx] ; ugenIdx -1 ⇒ outIdx is constant index
  numOut: number
  outRate: number
  special?: number
}

function f32be(n: number): number[] { const b = Buffer.alloc(4); b.writeFloatBE(n, 0); return [...b] }
function i32be(n: number): number[] { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return [...b] }
function i16be(n: number): number[] { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return [...b] } // handles negatives
function pstr(s: string): number[] { return [s.length, ...[...s].map((c) => c.charCodeAt(0))] }

function buildSynthDef(name: string, constants: number[], ugens: UGen[]): number[] {
  const out: number[] = []
  out.push(0x53, 0x43, 0x67, 0x66)        // "SCgf"
  out.push(...i32be(1))                    // version 1
  out.push(...i16be(1))                    // numDefs
  out.push(...pstr(name))
  out.push(...i16be(constants.length))
  for (const c of constants) out.push(...f32be(c))
  out.push(...i16be(0))                    // numParams
  out.push(...i16be(0))                    // numParamNames
  out.push(...i16be(ugens.length))
  for (const u of ugens) {
    out.push(...pstr(u.name))
    out.push(u.rate & 0xff)                // i8 rate
    out.push(...i16be(u.inputs.length))
    out.push(...i16be(u.numOut))
    out.push(...i16be(u.special ?? 0))
    for (const [a, b] of u.inputs) { out.push(...i16be(a)); out.push(...i16be(b)) }
    for (let i = 0; i < u.numOut; i++) out.push(u.outRate & 0xff)
  }
  out.push(...i16be(0))                    // numVariants
  return out
}

// Out.ar(0, [sig, sig]) where sig is ugen index `sigIdx` output 0; bus is constant `busConstIdx`.
function outStereo(sigIdx: number, busConstIdx: number): UGen {
  return { name: 'Out', rate: R_AUDIO, inputs: [[-1, busConstIdx], [sigIdx, 0], [sigIdx, 0]], numOut: 0, outRate: R_AUDIO }
}

// Each def: constants laid out as [freq, zero/bus, mul, (extra)].
const DEFS: Record<string, number[]> = {
  // SinOsc.ar(220, 0) * 0.3 → Out.ar(0, [.,.])
  sonic_pi_rawsin: buildSynthDef('sonic_pi_rawsin', [220, 0, 0.3], [
    { name: 'SinOsc', rate: R_AUDIO, inputs: [[-1, 0], [-1, 1]], numOut: 1, outRate: R_AUDIO },      // freq, phase=0
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[0, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(1, 1),
  ]),
  // Saw.ar(220) * 0.3 → Out.ar(0, [.,.])  — NO LPF, NO Normalizer
  sonic_pi_rawsaw: buildSynthDef('sonic_pi_rawsaw', [220, 0, 0.3], [
    { name: 'Saw', rate: R_AUDIO, inputs: [[-1, 0]], numOut: 1, outRate: R_AUDIO },                  // freq
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[0, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(1, 1),
  ]),
  // Pulse.ar(220, 0.5) * 0.3 → Out.ar(0, [.,.])
  sonic_pi_rawpulse: buildSynthDef('sonic_pi_rawpulse', [220, 0, 0.3, 0.5], [
    { name: 'Pulse', rate: R_AUDIO, inputs: [[-1, 0], [-1, 3]], numOut: 1, outRate: R_AUDIO },       // freq, width=0.5
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[0, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(1, 1),
  ]),
  // LFSaw.ar(220) * 0.3 — the NAIVE (aliased, non-band-limited) saw, as a cross-check.
  // If Saw==sine but LFSaw has harmonics, the band-limited family specifically is broken.
  sonic_pi_rawlfsaw: buildSynthDef('sonic_pi_rawlfsaw', [220, 0, 0.3], [
    { name: 'LFSaw', rate: R_AUDIO, inputs: [[-1, 0], [-1, 1]], numOut: 1, outRate: R_AUDIO },       // freq, iphase=0
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[0, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(1, 1),
  ]),

  // ── Round 2: isolate the downstream ugens unique to sonic-pi-saw ──
  // Saw(220) → LPF(cutoff=18000, wide open) → *0.3 → Out. If this is a sine, LPF ugen is broken.
  // constants: [freq, bus0, mul, cutoff]
  sonic_pi_sawlpf: buildSynthDef('sonic_pi_sawlpf', [220, 0, 0.3, 18000], [
    { name: 'Saw', rate: R_AUDIO, inputs: [[-1, 0]], numOut: 1, outRate: R_AUDIO },
    { name: 'LPF', rate: R_AUDIO, inputs: [[0, 0], [-1, 3]], numOut: 1, outRate: R_AUDIO },          // in, freq=18000
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[1, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(2, 1),
  ]),
  // Saw(220) → Normalizer(level=1, dur=0.01) → *0.3 → Out. If this is a sine, Normalizer ugen is broken.
  // constants: [freq, bus0, mul, level, dur]
  sonic_pi_sawnorm: buildSynthDef('sonic_pi_sawnorm', [220, 0, 0.3, 1, 0.01], [
    { name: 'Saw', rate: R_AUDIO, inputs: [[-1, 0]], numOut: 1, outRate: R_AUDIO },
    { name: 'Normalizer', rate: R_AUDIO, inputs: [[0, 0], [-1, 3], [-1, 4]], numOut: 1, outRate: R_AUDIO }, // in, level, dur(ir)
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[1, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(2, 1),
  ]),
  // Full chain: Saw → LPF(18000) → Normalizer → *0.3 → Out. Should reproduce the real :saw bug.
  sonic_pi_sawlpfnorm: buildSynthDef('sonic_pi_sawlpfnorm', [220, 0, 0.3, 18000, 1, 0.01], [
    { name: 'Saw', rate: R_AUDIO, inputs: [[-1, 0]], numOut: 1, outRate: R_AUDIO },
    { name: 'LPF', rate: R_AUDIO, inputs: [[0, 0], [-1, 3]], numOut: 1, outRate: R_AUDIO },
    { name: 'Normalizer', rate: R_AUDIO, inputs: [[1, 0], [-1, 4], [-1, 5]], numOut: 1, outRate: R_AUDIO },
    { name: 'BinaryOpUGen', rate: R_AUDIO, inputs: [[2, 0], [-1, 2]], numOut: 1, outRate: R_AUDIO, special: BINOP_MUL },
    outStereo(3, 1),
  ]),
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('Launching Chromium (headed, audio)...')
  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (m) => { const t = m.text(); if (/error|fail|not installed|warn|\[raw\]/i.test(t)) console.log(`  [page:${m.type()}] ${t}`) })
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

  await page.goto(BASE_URL)
  await page.waitForTimeout(1500)
  if (!(await page.evaluate(() => Boolean(document.querySelector('#app'))))) {
    throw new Error(`${BASE_URL} is not the SonicPi.js app (run npm run dev first).`)
  }

  // Boot the engine (init happens on first Run). Run a silent snippet.
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await editor.fill('sleep 0.1')
  await page.locator('.spw-btn-label:has-text("Run")').click()

  // Wait for engine + bridge.sonic + running audio context.
  await page.waitForFunction(() => {
    const e: any = (window as any).__spw_engine
    return e && e.bridge && e.bridge.sonic && e.bridge.audioContext && e.bridge.audioContext.state === 'running' && e.bridge.masterOutputNode
  }, { timeout: 20000 })
  console.log('Engine + scsynth ready.')
  await page.waitForTimeout(500)

  // ── Round 3: drive the REAL, already-loaded sonic-pi-saw via raw /s_new ──
  // Bypasses the engine SoundLayer. params flattened [k,v,k,v,...].
  // note 52 = E3. cutoff 130 ≈ 14.9kHz (wide open). out_bus 0.
  const REAL_TESTS: Array<{ label: string; synth: string; params: (string | number)[] }> = [
    { label: 'real_saw_cut130', synth: 'sonic-pi-saw', params: ['note', 52, 'amp', 1, 'attack', 0, 'decay', 0, 'sustain', 3, 'release', 0.2, 'cutoff', 130, 'env_curve', 1, 'out_bus', 0, 'pan', 0] },
    { label: 'real_saw_cut140', synth: 'sonic-pi-saw', params: ['note', 52, 'amp', 1, 'attack', 0, 'decay', 0, 'sustain', 3, 'release', 0.2, 'cutoff', 140, 'env_curve', 1, 'out_bus', 0, 'pan', 0] },
    { label: 'real_saw_default', synth: 'sonic-pi-saw', params: ['note', 52, 'amp', 1, 'sustain', 3, 'out_bus', 0] },
  ]

  // Unified job list: hand-built defs (need /d_recv) + real synths (params only).
  const jobs: Array<{ label: string; name: string; bytes: number[] | null; params: (string | number)[] }> = [
    ...Object.entries(DEFS).map(([name, bytes]) => ({ label: name, name, bytes, params: [] as (string | number)[] })),
    ...REAL_TESTS.map((t) => ({ label: t.label, name: t.synth, bytes: null, params: t.params })),
  ]

  let nodeId = 9001
  for (const job of jobs) {
    const { label, name, bytes, params } = job
    console.log(`\n── ${label}${bytes ? ` (${bytes.length} bytes)` : ` [real ${name}]`} ──`)
    // In-page code passed as a STRING literal so esbuild/tsx does not inject
    // its `__name` helper into the page (which has no such global) — same
    // workaround capture.ts uses for its engine hook.
    const arg = JSON.stringify({ name, bytes, params, durMs: REC_MS, nid: nodeId })
    const b64 = await page.evaluate(`(async (A) => {
      var e = window.__spw_engine;
      var bridge = e.bridge, sonic = bridge.sonic;
      var ctx = bridge.audioContext;
      var tap = bridge.masterOutputNode;

      if (A.bytes) {
        sonic.send('/d_recv', new Uint8Array(A.bytes));
        await new Promise(function(r){ setTimeout(r, 300); });
      }

      var CH = 2, BUF = 4096;
      var chunks = [[], []];
      var sp = ctx.createScriptProcessor(BUF, CH, CH);
      sp.onaudioprocess = function(ev){
        var inp = ev.inputBuffer;
        var nc = Math.min(inp.numberOfChannels, CH);
        for (var ch = 0; ch < nc; ch++) { chunks[ch].push(new Float32Array(inp.getChannelData(ch))); }
      };
      var sink = ctx.createGain(); sink.gain.value = 0;
      tap.connect(sp); sp.connect(sink); sink.connect(ctx.destination);

      sonic.send.apply(sonic, ['/s_new', A.name, A.nid, 1, 100].concat(A.params || []));
      await new Promise(function(r){ setTimeout(r, A.durMs); });
      sonic.send('/n_free', A.nid);

      await new Promise(function(r){ setTimeout(r, (BUF / ctx.sampleRate) * 1000 + 60); });
      try { tap.disconnect(sp); } catch(_) {}
      try { sp.disconnect(); } catch(_) {}
      try { sink.disconnect(); } catch(_) {}
      sp.onaudioprocess = null;

      var len = chunks[0].reduce(function(a,c){ return a + c.length; }, 0);
      var flat = chunks.map(function(cs){
        var o = new Float32Array(len), p = 0;
        for (var i = 0; i < cs.length; i++) { o.set(cs[i], p); p += cs[i].length; }
        return o;
      });
      var sr = ctx.sampleRate;
      var blockAlign = CH * 2;
      var dataLen = len * blockAlign;
      var buf = new ArrayBuffer(44 + dataLen);
      var dv = new DataView(buf);
      var ws = function(off, s){ for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
      ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, CH, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * blockAlign, true);
      dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
      ws(36, 'data'); dv.setUint32(40, dataLen, true);
      var off = 44;
      for (var i = 0; i < len; i++) {
        for (var ch = 0; ch < CH; ch++) {
          var s = Math.max(-1, Math.min(1, flat[ch][i]));
          dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
        }
      }
      var bin = '';
      var u8 = new Uint8Array(buf);
      for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return { b64: btoa(bin), len: len, sr: sr };
    })(${arg})`) as { b64: string; len: number; sr: number }

    nodeId++
    const wavPath = resolve(OUT_DIR, `${label}.wav`)
    writeFileSync(wavPath, Buffer.from(b64.b64, 'base64'))
    console.log(`  saved ${wavPath}  (${b64.len} frames @ ${b64.sr}Hz)`)
    await page.waitForTimeout(300)
  }

  await browser.close()
  console.log(`\nDone. WAVs in ${OUT_DIR}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
