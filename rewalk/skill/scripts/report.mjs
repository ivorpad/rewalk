import fs from 'node:fs'
const OUT = process.env.OUT ?? 'out'
const run = JSON.parse(fs.readFileSync(OUT + '/run.json', 'utf8'))
const all = run.flows.flatMap(f => f.steps.map(s => ({ ...s, flow: f.id })))
const bad = all.filter(s => s.status === 'FAIL')

const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
const cols = ['flow_id','step','action','target','value','expect','req','status','expected','actual','error','t_start','t_end']
fs.writeFileSync(OUT + '/results.csv',
  [cols.join(','), ...all.map(r => cols.map(c => esc(r[c] ?? '')).join(','))].join('\n'))

fs.writeFileSync(OUT + '/report.md', [
  `# QA run`, ``,
  `${all.length - bad.length}/${all.length} steps passed across ${run.flows.length} flows.`, ``,
  `Replay: open \`replay.html\` (self-contained, no server needed).`, ``,
  `| flow | step | req | status | expected | actual |`,
  `|---|---|---|---|---|---|`,
  ...all.map(r => `| ${r.flow} | ${r.step} \`${r.action} ${(r.target || r.expect || '').slice(0, 34)}\` | ${r.req} | ${r.status === 'pass' ? 'pass' : '**FAIL**'} | ${(r.expected || '').slice(0, 40)} | ${(r.actual || '').slice(0, 46)} |`),
  ``,
  ...(bad.length ? [`## Failures`, ``, ...bad.map(r =>
    `### ${r.flow} step ${r.step} — ${r.req}\n\n\`${r.action} ${r.target || ''} ${r.value || ''}\`\n\n` +
    `- expected: \`${r.expected}\`\n- actual: \`${r.actual}\`\n- ${r.error}\n` +
    `- replay: open \`replay.html\`, flow **${r.flow}**, step **${r.step}** (${r.t_start}ms)\n` +
    `- dom forensics: \`playwright show-trace traces/${r.flow}.zip\`\n`)] : [`No failures.`]),
].join('\n'))
console.log(OUT + `/report.md + out/results.csv  (${all.length - bad.length}/${all.length} passed)`)
