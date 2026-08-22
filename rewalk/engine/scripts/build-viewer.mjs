import fs from 'node:fs'
const OUT = process.env.OUT ?? 'out'
import path from 'node:path'
const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..') + '/'
if (!fs.existsSync(ROOT + 'node_modules/rrweb-player/dist/rrweb-player.umd.cjs')) {
  console.error(`\nweb-qa: dependencies are not installed.\n  cd ${ROOT.replace(process.env.HOME, '~')} && npm install\n`)
  process.exit(3)
}
import zlib from 'node:zlib'

const run = JSON.parse(fs.readFileSync(OUT + '/run.json', 'utf8'))
const playerJs  = fs.readFileSync(ROOT + 'node_modules/rrweb-player/dist/rrweb-player.umd.cjs', 'utf8')
const playerCss = fs.readFileSync(ROOT + 'node_modules/rrweb-player/dist/style.css', 'utf8')

const packed = {}
for (const f of run.flows) {
  const raw = fs.readFileSync(OUT + `/replay/${f.id}.json`)
  packed[f.id] = zlib.gzipSync(raw, { level: 9 }).toString('base64')
}
// events live in PACKED; keep run.json lean in the page
const meta = { ...run, flows: run.flows.map(({ steps, net, id, t0Epoch, duration }) => ({ id, t0Epoch, duration, steps, net })) }

const html = fs.readFileSync(ROOT + 'assets/viewer.template.html', 'utf8')
  .replace('__PLAYER_JS__', () => playerJs)
  .replace('__RUN_JSON__', () => JSON.stringify(meta))
  .replace('__PACKED__', () => JSON.stringify(packed))
  .replace('<style>', `<style>\n${playerCss}\n`)

fs.writeFileSync(OUT + '/replay.html', html)
console.log(OUT + `/replay.html  ${(fs.statSync(OUT + '/replay.html').size / 1024 / 1024).toFixed(2)} MB  (${run.flows.length} flows, ${run.flows.flatMap(f => f.steps).length} steps, self-contained)`)
