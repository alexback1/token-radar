// Launch Signal — token-radar-01 entry runner (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every rankable pre-token protocol with the
// fitted model in lib/model.ts, writes the ranked board to /output/board.json,
// writes the dashboard's data beside the page, copies dashboard/ and
// screenshots/ to /output, and writes /output/dossier.json with the vendored
// make.fun library. Run it outside the grader with MAKEFUN_OUTPUT_DIR set:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch signal: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch signal: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const meta = {
  model_version: radar.model_version,
  as_of: radar.as_of,
  source: radar.source,
  floor_usd: radar.floor_usd,
  scanned_protocols: radar.scanned,
  watchlist_size: radar.watchlist_size,
  board_size: radar.board_size,
  validation: radar.validation,
  verdict_rule: 'FARM if implied >= $10,000,000; THIN if >= $2,000,000; else SKIP.',
  verdict_counts: {
    FARM: board.filter((r) => r.farm.verdict === 'FARM').length,
    THIN: board.filter((r) => r.farm.verdict === 'THIN').length,
    SKIP: board.filter((r) => r.farm.verdict === 'SKIP').length,
  },
};
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ meta, rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launch signal: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch signal: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const verdicts = meta.verdict_counts;
process.stdout.write(
  `launch signal: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ` +
    `(FARM ${verdicts.FARM}, THIN ${verdicts.THIN}, SKIP ${verdicts.SKIP})\n` +
    `launch signal: fit log(mcap) = ${radar.validation.fit.a.toFixed(4)} + ${radar.validation.fit.b.toFixed(4)} * log(TVL) on ${radar.validation.fit.n} comps\n` +
    `launch signal: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
