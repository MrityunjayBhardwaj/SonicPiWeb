/**
 * test_results/ inspector builder — mirrors the FX sweep artifacts from
 * `.captures/` into one folder per FX so a single index.html can audition
 * each desktop ↔ web pair side-by-side.
 *
 * Why: PR #275 emits per-FX artifacts to four scattered locations
 * (`.captures/fx-sweep/<fx>.json`, `.captures/desktop-recordings/*`,
 * `.captures/2026-*_inline_audio.wav`, `.captures/compare_*_fx-<fx>_*`).
 * Auditing 40 FX in 4 dirs each is friction. This tool consolidates each
 * FX's artifacts into `test_results/fx/<fx>/` and emits a baseline JSON
 * shaped for the inspector HTML.
 *
 * `.captures/` stays canonical — this tool only copies, never moves.
 *
 * Usage:
 *   npx tsx tools/build-test-results.ts
 *
 * Output:
 *   test_results/index.html              (left in place, never overwritten)
 *   test_results/fx-baseline.json        (regenerated)
 *   test_results/fx/<fx>/desktop.wav     (copy)
 *   test_results/fx/<fx>/web.wav         (copy)
 *   test_results/fx/<fx>/spectrogram.png (copy)
 *   test_results/fx/<fx>/perbeat.png     (copy, may be missing for INCONCLUSIVE)
 *   test_results/fx/<fx>/snippet.rb      (copy)
 *   test_results/fx/<fx>/metrics.json    (copy of sidecar)
 *   test_results/fx/<fx>/report.md       (copy of comparator report)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CAPTURES_DIR = path.join(REPO_ROOT, '.captures');
const SWEEP_DIR = path.join(CAPTURES_DIR, 'fx-sweep');
const BASELINE_PATH = path.join(CAPTURES_DIR, 'fx-baseline.json');
const OUT_DIR = path.join(REPO_ROOT, 'test_results');
const OUT_FX_DIR = path.join(OUT_DIR, 'fx');
const OUT_BASELINE_PATH = path.join(OUT_DIR, 'fx-baseline.json');

type Verdict = 'HIGH' | 'MID' | 'LOW' | 'INCONCLUSIVE';

interface BaselineEntry {
  verdict: Verdict;
  score: number;
  rmsRatio: number | null;
  peakRatio: number | null;
  l2MelDb: number;
  mfccDist: number;
}

interface PerBeatRow {
  beat: number;
  desktop_rms: number;
  web_rms: number;
  desktop_peak: number;
  web_peak: number;
  mfcc_distance: number;
}

interface SidecarPerBeat {
  bpm: number;
  beats: number;
  rows: PerBeatRow[];
  most_divergent_beats: number[];
  mean_per_beat_mfcc_distance: number;
  per_beat_png?: string;
}

interface SidecarSpectrogram {
  l2_mel_db: number;
  mfcc_distance: number;
  frames_compared: number;
  spectrogram_png?: string;
  desktop_peak_freq_hz?: number;
  web_peak_freq_hz?: number;
  per_beat?: SidecarPerBeat;
}

interface Sidecar {
  timestamp: string;
  code: string;
  duration: number;
  name: string;
  desktop: { wavPath: string; stats: AudioStats; ok: boolean };
  web: { wavPath: string; stats: AudioStats; ok: boolean };
  spectrogram?: SidecarSpectrogram;
  spectrogramError?: string | null;
  reportPath?: string;
}

interface AudioStats {
  duration: number;
  peak: number;
  rms: number;
  clipping: number;
  sampleRate: number;
  channels: number;
}

interface InspectorEntry extends BaselineEntry {
  fx: string;
  flavor: 'rhythmic' | 'sustained';
  duration: number;
  bpm: number;
  beats: number;
  desktopStats: AudioStats;
  webStats: AudioStats;
  perBeat: PerBeatRow[];
  mostDivergentBeats: number[];
  artifacts: {
    desktopWav: string | null;
    webWav: string | null;
    spectrogramPng: string | null;
    perBeatPng: string | null;
    snippet: string | null;
    metrics: string | null;
    report: string | null;
  };
}

// Mirror of the sustained-flavor list in tools/fx-sweep.ts (search SnippetFlavor).
// Kept in sync manually — small set, low churn.
const SUSTAINED_FX = new Set([
  'panslicer',
  'slicer',
  'wobble',
  'tremolo',
  'vowel',
  'ring_mod',
]);

function flavor(fx: string): 'rhythmic' | 'sustained' {
  return SUSTAINED_FX.has(fx) ? 'sustained' : 'rhythmic';
}

function copyIfExists(src: string | null | undefined, dst: string): boolean {
  if (!src) return false;
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dst);
  return true;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function pruneStaleDirs(parent: string, keep: Set<string>): number {
  if (!fs.existsSync(parent)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
    n++;
  }
  return n;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function loadBaseline(): Record<string, BaselineEntry> {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `fx-baseline.json not found at ${BASELINE_PATH}. Run \`npm run fx-sweep\` first.`,
    );
  }
  return readJson<Record<string, BaselineEntry>>(BASELINE_PATH);
}

function loadSidecar(fx: string): Sidecar | null {
  const sidecarPath = path.join(SWEEP_DIR, `${fx}.json`);
  if (!fs.existsSync(sidecarPath)) return null;
  return readJson<Sidecar>(sidecarPath);
}

function build(): void {
  console.log('[inspector] reading baseline + sidecars from .captures/');
  const baseline = loadBaseline();
  const fxNames = Object.keys(baseline);
  console.log(`[inspector] ${fxNames.length} FX in baseline`);

  ensureDir(OUT_FX_DIR);
  const expected = new Set(fxNames);
  const pruned = pruneStaleDirs(OUT_FX_DIR, expected);
  if (pruned > 0) console.log(`[inspector] pruned ${pruned} stale FX dir(s)`);

  const entries: InspectorEntry[] = [];
  let copied = 0;
  let missing = 0;

  for (const fx of fxNames) {
    const base = baseline[fx];
    const sidecar = loadSidecar(fx);
    const fxDir = path.join(OUT_FX_DIR, fx);
    ensureDir(fxDir);

    const snippetSrc = path.join(SWEEP_DIR, `snippet-${fx}.rb`);
    const sidecarSrc = path.join(SWEEP_DIR, `${fx}.json`);

    const desktopWav = path.join(fxDir, 'desktop.wav');
    const webWav = path.join(fxDir, 'web.wav');
    const spectrogramPng = path.join(fxDir, 'spectrogram.png');
    const perBeatPng = path.join(fxDir, 'perbeat.png');
    const snippetDst = path.join(fxDir, 'snippet.rb');
    const metricsDst = path.join(fxDir, 'metrics.json');
    const reportDst = path.join(fxDir, 'report.md');

    const okDesktop = copyIfExists(sidecar?.desktop?.wavPath, desktopWav);
    const okWeb = copyIfExists(sidecar?.web?.wavPath, webWav);
    const okSpectro = copyIfExists(sidecar?.spectrogram?.spectrogram_png, spectrogramPng);
    const okPerBeat = copyIfExists(sidecar?.spectrogram?.per_beat?.per_beat_png, perBeatPng);
    const okSnippet = copyIfExists(snippetSrc, snippetDst);
    const okMetrics = copyIfExists(sidecarSrc, metricsDst);
    const okReport = copyIfExists(sidecar?.reportPath, reportDst);

    if (okDesktop) copied++; else missing++;
    if (okWeb) copied++; else missing++;

    const stats = sidecar
      ? { desktop: sidecar.desktop.stats, web: sidecar.web.stats }
      : null;
    const sg = sidecar?.spectrogram;
    const pb = sg?.per_beat;

    entries.push({
      fx,
      flavor: flavor(fx),
      verdict: base.verdict,
      score: base.score,
      rmsRatio: base.rmsRatio,
      peakRatio: base.peakRatio,
      l2MelDb: base.l2MelDb,
      mfccDist: base.mfccDist,
      duration: sidecar?.duration ?? 5000,
      bpm: pb?.bpm ?? 120,
      beats: pb?.beats ?? 0,
      desktopStats: stats?.desktop ?? emptyStats(),
      webStats: stats?.web ?? emptyStats(),
      perBeat: pb?.rows ?? [],
      mostDivergentBeats: pb?.most_divergent_beats ?? [],
      artifacts: {
        desktopWav: okDesktop ? `fx/${fx}/desktop.wav` : null,
        webWav: okWeb ? `fx/${fx}/web.wav` : null,
        spectrogramPng: okSpectro ? `fx/${fx}/spectrogram.png` : null,
        perBeatPng: okPerBeat ? `fx/${fx}/perbeat.png` : null,
        snippet: okSnippet ? `fx/${fx}/snippet.rb` : null,
        metrics: okMetrics ? `fx/${fx}/metrics.json` : null,
        report: okReport ? `fx/${fx}/report.md` : null,
      },
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sourceBaseline: path.relative(REPO_ROOT, BASELINE_PATH),
    counts: tally(entries),
    entries: sortEntries(entries),
  };

  fs.writeFileSync(OUT_BASELINE_PATH, JSON.stringify(out, null, 2));
  console.log(`[inspector] wrote ${OUT_BASELINE_PATH}`);
  console.log(`[inspector] copied ${copied} WAV files (${missing} absent)`);
  console.log(`[inspector] open: file://${path.join(OUT_DIR, 'index.html')}`);
}

function emptyStats(): AudioStats {
  return { duration: 0, peak: 0, rms: 0, clipping: 0, sampleRate: 0, channels: 0 };
}

function tally(entries: InspectorEntry[]): Record<Verdict, number> {
  const t: Record<Verdict, number> = { HIGH: 0, MID: 0, LOW: 0, INCONCLUSIVE: 0 };
  for (const e of entries) t[e.verdict] = (t[e.verdict] ?? 0) + 1;
  return t;
}

function sortEntries(entries: InspectorEntry[]): InspectorEntry[] {
  return entries.slice().sort((a, b) => {
    const aIncon = a.verdict === 'INCONCLUSIVE' ? 1 : 0;
    const bIncon = b.verdict === 'INCONCLUSIVE' ? 1 : 0;
    if (aIncon !== bIncon) return aIncon - bIncon;
    return b.score - a.score;
  });
}

build();
