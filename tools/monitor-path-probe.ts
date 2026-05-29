/**
 * Monitor-path isolation probe (SP108 / #417 round 5).
 *
 * Replicates the live_loop routing WITHOUT a live_loop and WITHOUT a hot-swap:
 *   real sonic-pi-saw (cutoff 130) → out_bus = freshly allocated bus B
 *   sonic_pi_track_monitor: In.ar(B,2) → Out.ar(0) [+ track bus]
 * then records masterOutputNode.
 *
 * Round 3 proved sonic-pi-saw → out_bus 0 (direct) = full harmonics.
 * If routing through the monitor turns it into a sine, the per-loop monitor /
 * In.ar path is the harmonic-stripping culprit.
 *
 * Variants:
 *   A. direct  : saw → out_bus 0                       (control, expect harmonics)
 *   B. monitor : saw → bus B ; monitor In.ar(B) → 0    (expect ??? )
 *
 * Usage: npx tsx tools/monitor-path-probe.ts
 */
import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = '/tmp/sp108-raw-ugen'
const REC_MS = 2500

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

  await page.goto(BASE_URL)
  await page.waitForTimeout(1500)
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace')
  await editor.fill('sleep 0.1')
  await page.locator('.spw-btn-label:has-text("Run")').click()
  await page.waitForFunction(() => {
    const e: any = (window as any).__spw_engine
    return e && e.bridge && e.bridge.sonic && e.bridge.audioContext && e.bridge.audioContext.state === 'running' && e.bridge.masterOutputNode
  }, { timeout: 20000 })
  await page.waitForTimeout(500)

  // Each variant returns {b64,len,sr,info}. `useMonitor` toggles the routing.
  const variants = [
    { label: 'mp_direct', useMonitor: false },
    { label: 'mp_monitor', useMonitor: true },
  ]
  let nid = 9501
  for (const v of variants) {
    console.log(`\n── ${v.label} (monitor=${v.useMonitor}) ──`)
    const arg = JSON.stringify({ useMonitor: v.useMonitor, durMs: REC_MS, nid })
    const out = await page.evaluate(`(async (A) => {
      var e = window.__spw_engine, bridge = e.bridge, sonic = bridge.sonic;
      var ctx = bridge.audioContext, tap = bridge.masterOutputNode;
      var info = {};
      var sawOutBus = 0, monId = 0, loopBus = 0;
      if (A.useMonitor) {
        loopBus = bridge.allocateBus();          // same call createLoopMonitor uses
        sawOutBus = loopBus;
        monId = sonic.nextNodeId();
        // monitor in group 102 (after synths group 100, before mixer)
        sonic.send('/s_new', 'sonic_pi_track_monitor', monId, 1, 102,
          'in_bus', loopBus, 'out_bus_master', 0, 'out_bus_track', 0, 'amp', 1);
        info.loopBus = loopBus; info.monId = monId;
        await new Promise(function(r){ setTimeout(r, 100); });
      }
      // start tap
      var CH = 2, BUF = 4096, chunks = [[], []];
      var sp = ctx.createScriptProcessor(BUF, CH, CH);
      sp.onaudioprocess = function(ev){ var inp = ev.inputBuffer; var nc = Math.min(inp.numberOfChannels, CH); for (var ch=0; ch<nc; ch++) chunks[ch].push(new Float32Array(inp.getChannelData(ch))); };
      var sink = ctx.createGain(); sink.gain.value = 0;
      tap.connect(sp); sp.connect(sink); sink.connect(ctx.destination);

      sonic.send('/s_new', 'sonic-pi-saw', A.nid, 0, 100,
        'note', 52, 'amp', 1, 'attack', 0, 'sustain', 3, 'release', 0.2, 'cutoff', 130, 'out_bus', sawOutBus);
      info.sawOutBus = sawOutBus;
      await new Promise(function(r){ setTimeout(r, A.durMs); });
      sonic.send('/n_free', A.nid);
      if (monId) sonic.send('/n_free', monId);

      await new Promise(function(r){ setTimeout(r, (BUF / ctx.sampleRate) * 1000 + 60); });
      try { tap.disconnect(sp); } catch(_){}
      try { sp.disconnect(); } catch(_){}
      try { sink.disconnect(); } catch(_){}
      sp.onaudioprocess = null;

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
      return { b64: btoa(bin), len: len, sr: sr, info: info };
    })(${arg})`) as { b64: string; len: number; sr: number; info: any }
    nid++
    writeFileSync(resolve(OUT_DIR, `${v.label}.wav`), Buffer.from(out.b64, 'base64'))
    console.log(`  saved ${v.label}.wav  routing=${JSON.stringify(out.info)}`)
    await page.waitForTimeout(300)
  }
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
