// Stream 16k mono linear16 PCM to Deepgram live, collect wall-stamped utterances.
//
// Reuses the connection recipe proven in 2026-03-16-aemal-vibestage-desktop:
// nova-3, interim_results with utterance_end_ms + endpointing, so Deepgram does
// the utterance segmentation server-side -- the same word-timed boundaries that
// beat energy VAD when a speaker runs complaints together. Node 22+ ships a
// global WebSocket, so no dependency.
//
// The caller pushes PCM (push) and eventually ends (finish). Each final
// transcript is turned into { text, from, to } in ms from stream start; the
// companion stamps wall time onto those with the audio clock, so an utterance
// indexes straight into the DOM stream. No beacon: one machine, one clock.
import { deepgramKey, DEEPGRAM_MODEL } from './utterances.mjs'

export function openDeepgramStream({ model = DEEPGRAM_MODEL, onUtterance = () => {} } = {}) {
  const k = deepgramKey()
  if (!k.ok) throw new Error(k.reason)
  const params = new URLSearchParams({
    model, language: 'en', smart_format: 'true', interim_results: 'true',
    utterance_end_ms: '1500', vad_events: 'true', endpointing: '400',
    encoding: 'linear16', sample_rate: '16000', channels: '1', punctuate: 'true',
  })
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, { headers: { Authorization: `Token ${k.key}` } })
  ws.binaryType = 'arraybuffer'
  const utterances = []
  let ready = false, keepAlive = null
  const pending = []

  ws.addEventListener('open', () => {
    ready = true
    keepAlive = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'KeepAlive' })) }, 8000)
    for (const b of pending.splice(0)) ws.send(b)
  })
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return
    let m; try { m = JSON.parse(e.data) } catch (x) { return }
    if (m.type === 'Results' && m.is_final) {
      const t = m.channel?.alternatives?.[0]?.transcript
      if (t) { const u = { text: t, from: Math.round(m.start * 1000), to: Math.round((m.start + m.duration) * 1000) }; utterances.push(u); onUtterance(u) }
    }
  })

  return {
    ws, utterances,
    push(pcm) { const b = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm); if (ready && ws.readyState === 1) ws.send(b); else pending.push(b) },
    finish() {
      return new Promise((resolve) => {
        const done = () => { clearInterval(keepAlive); resolve(utterances) }
        ws.addEventListener('close', done)
        try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); else done() } catch (e) { done() }
        setTimeout(done, 20000)   // safety net; normally 'close' fires first, after Deepgram flushes finals
      })
    },
  }
}

/** Read the data chunk offset of a 16k mono wav (or 0 for headerless). */
export function wavDataOffset(buf) {
  if (!(buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF')) return 0
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), sz = buf.readUInt32LE(off + 4)
    if (id === 'data') return off + 8
    off += 8 + sz + (sz & 1)
  }
  return 44
}
