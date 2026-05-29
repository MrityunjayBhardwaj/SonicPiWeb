/**
 * Engine-path saw probe v2 (SP108 / #417) — FRESH single run, full OSC capture.
 *
 * Arms OSC capture + audio tap via the __spw_engine setter (before init), then
 * does ONE fresh run of the code (no hot-swap). Reproduces the capture.ts sine
 * while logging EVERY OSC message the engine sends — so we can diff what the
 * real live_loop path does vs the manual replication that preserves harmonics.
 *
 * Usage: SAW_CODE="$(cat /tmp/iso_saw_hicut.rb)" npx tsx tools/engine-saw-osc-probe.ts
 */
import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = '/tmp/sp108-raw-ugen'
const CODE = process.env.SAW_CODE ?? 'use_synth :saw\nlive_loop :s do\n  play :E3, amp: 0.5, attack: 0, sustain: 1, release: 0.25, cutoff: 130\n  sleep 1\nend'
const RUN_MS = Number(process.env.RUN_MS ?? 5000)

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const ctx = await browser.newContext()

  // Arm OSC capture + tap via the __spw_engine setter, BEFORE the app inits.
  await ctx.addInitScript({ content: `(function(){
    window.__oscLog = [];
    var _eng = null;
    Object.defineProperty(window, '__spw_engine', {
      configurable: true,
      get: function(){ return _eng; },
      set: function(e){
        _eng = e;
        try {
          var bridge = e.bridge;
          var prev = bridge.oscTraceHandler;
          bridge.setOscTraceHandler(function(s){ window.__oscLog.push(s); if (prev) try { prev(s); } catch(_){} });
          // install audio tap on masterOutputNode
          var actx = bridge.audioContext, tap = bridge.masterOutputNode;
          var CH = 2, BUF = 4096, chunks = [[], []];
          var sp = actx.createScriptProcessor(BUF, CH, CH);
          sp.onaudioprocess = function(ev){ var inp = ev.inputBuffer; var nc = Math.min(inp.numberOfChannels, CH); for (var ch=0; ch<nc; ch++) chunks[ch].push(new Float32Array(inp.getChannelData(ch))); };
          var sink = actx.createGain(); sink.gain.value = 0;
          tap.connect(sp); sp.connect(sink); sink.connect(actx.destination);
          window.__probe = { chunks: chunks, sp: sp, sink: sink, tap: tap, ctx: actx };
        } catch(err){ window.__probeErr = String(err); }
      }
    });
  })()` })

  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))
  await page.goto(BASE_URL)
  await page.waitForTimeout(1500)

  // Single fresh run of the code.
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace')
  await editor.fill(CODE)
  await page.locator('.spw-btn-label:has-text("Run")').click()

  // Wait for the probe to arm (engine inited) then run window.
  await page.waitForFunction(() => Boolean((window as any).__probe), { timeout: 20000 })
  await page.waitForTimeout(RUN_MS)

  const out = await page.evaluate(`(function(){
    var p = window.__probe; if (!p) return { err: window.__probeErr || 'no probe' };
    var ctx = p.ctx, chunks = p.chunks, CH = 2, BUF = 4096;
    try { p.tap.disconnect(p.sp); } catch(_){}
    try { p.sp.disconnect(); } catch(_){}
    try { p.sink.disconnect(); } catch(_){}
    p.sp.onaudioprocess = null;
    var len = chunks[0].reduce(function(a,c){ return a+c.length; }, 0);
    var flat = chunks.map(function(cs){ var o=new Float32Array(len),q=0; for (var i=0;i<cs.length;i++){o.set(cs[i],q);q+=cs[i].length;} return o; });
    var sr = ctx.sampleRate, blockAlign = CH*2, dataLen = len*blockAlign;
    var buf = new ArrayBuffer(44+dataLen), dv = new DataView(buf);
    var ws = function(off,s){ for (var i=0;i<s.length;i++) dv.setUint8(off+i, s.charCodeAt(i)); };
    ws(0,'RIFF'); dv.setUint32(4,36+dataLen,true); ws(8,'WAVE'); ws(12,'fmt '); dv.setUint32(16,16,true);
    dv.setUint16(20,1,true); dv.setUint16(22,CH,true); dv.setUint32(24,sr,true); dv.setUint32(28,sr*blockAlign,true);
    dv.setUint16(32,blockAlign,true); dv.setUint16(34,16,true); ws(36,'data'); dv.setUint32(40,dataLen,true);
    var off=44; for (var i=0;i<len;i++){ for (var ch=0; ch<CH; ch++){ var s=Math.max(-1,Math.min(1,flat[ch][i])); dv.setInt16(off, s<0?s*0x8000:s*0x7fff, true); off+=2; } }
    var bin='', u8=new Uint8Array(buf); for (var i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]);
    return { b64: btoa(bin), len: len, sr: sr, osc: window.__oscLog };
  })()`) as { b64?: string; len?: number; sr?: number; osc?: string[]; err?: string }

  if (out.err) { console.log('PROBE ERROR:', out.err); await browser.close(); return }
  writeFileSync(resolve(OUT_DIR, 'engine_saw_fresh.wav'), Buffer.from(out.b64!, 'base64'))
  console.log(`saved engine_saw_fresh.wav (${out.len} frames @ ${out.sr}Hz)`)
  console.log(`\n=== ALL OSC the engine sent (${out.osc!.length} msgs) ===`)
  for (const line of out.osc!) console.log('  ' + line)
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
