// JSDoc contracts for the session artifacts and the join.
// Runtime-empty: tsc --checkJs reads these typedefs. Not a TypeScript migration.

/**
 * One flattened DOM change from extractDeltas.
 * `from`/`to` are strings, numbers, or null depending on kind.
 * @typedef {object} Delta
 * @property {number} at
 * @property {string} kind
 * @property {string} node
 * @property {string} prop
 * @property {unknown} from
 * @property {unknown} to
 * @property {number|null} mag
 * @property {number} [area]
 * @property {number} [ticks]
 * @property {number} [score]
 * @property {Record<string, number>} [parts]
 * @property {number} [changedInSteps]
 * @property {number} [ofSteps]
 */

/**
 * Component identity walked from the fiber under the click, live at mark time
 * (tick.js). chain: authored names innermost-first; anon: composites whose
 * names did not survive minification; props: prop KEYS of the innermost named
 * client component, never values.
 * @typedef {object} MarkReact
 * @property {string[]} chain
 * @property {number} [anon]
 * @property {string[]} [props]
 */

/**
 * @typedef {object} Mark
 * @property {number} at
 * @property {number} [elapsedMs]
 * @property {string} [kind]
 * @property {string} [s]
 * @property {string} [text]
 * @property {string[]} [chain]
 * @property {MarkReact} [react]
 */

/**
 * Page-clock pair from rewalk-clock events.
 * @typedef {object} ClockPair
 * @property {number} at
 * @property {number} recorderElapsedMs
 * @property {number} wall
 */

/**
 * Per-segment audio clock in session.json (and the fitted object clockOf returns).
 * @typedef {object} AudioClock
 * @property {string} file
 * @property {string} [device]
 * @property {boolean} ok
 * @property {number} [ticks]
 * @property {number} [startWall]
 * @property {number} [driftPpm]
 * @property {number} [residualMs]
 * @property {string} [reason]
 * @property {number} [dropRate]
 * @property {boolean} [corrected]
 * @property {number} [fileMs]
 * @property {number} [spanMs]
 * @property {(ms: number) => number} [toWall]
 */

/**
 * session.json — watch-route and paired/extension shapes share these fields.
 * @typedef {object} SessionJson
 * @property {string|null} [url]
 * @property {string} [via]
 * @property {number} [browserReadyWall]
 * @property {number} [endedWall]
 * @property {number} [events]
 * @property {MicSegment[]} [mic]
 * @property {object[]} [micEvents]
 * @property {AudioClock[]} [audioClocks]
 * @property {number} [utterances]
 * @property {boolean} [streamed]
 * @property {boolean} [micDead]
 * @property {string|null} [micReason]
 */

/**
 * One line of utterances.ndjson (Deepgram live) or a transcribed region.
 * @typedef {object} UtteranceRow
 * @property {string} text
 * @property {number} from
 * @property {number} to
 * @property {number} [wall]
 * @property {number} [fragments]
 * @property {number} [words]
 * @property {number} [confidence]
 */

/**
 * Input to resolveUtterance. `end` only on stitched cards.
 * @typedef {object} ResolveInput
 * @property {string} text
 * @property {number} at
 * @property {number} [end]
 */

/**
 * @typedef {object} ResolveWindow
 * @property {number} back
 * @property {number} fwd
 */

/**
 * @typedef {object} Churn
 * @property {number} steps
 * @property {Map<string, number>} seen
 */

/**
 * @typedef {object} ResolveContext
 * @property {Delta[]} deltas
 * @property {Mark[]} marks
 * @property {Churn} churn
 * @property {ResolveWindow} [window]
 * @property {Set<string>|null} [ambient]
 * @property {Array<{at: number, ms?: number}>|null} [net]
 * @property {Array<{at: number}>|null} [consoleEvents]
 */

/**
 * @typedef {object} Interaction
 * @property {number} at
 * @property {string} [kind]
 * @property {string} [s]
 * @property {string} [text]
 */

/**
 * Stasis candidate in resolved.json `held[]`.
 * @typedef {object} Held
 * @property {string} node
 * @property {string} prop
 * @property {string} kind
 * @property {number} changedInSteps
 * @property {number} ofSteps
 * @property {number} score
 */

/**
 * One entry of resolved.json.
 * @typedef {object} ResolvedUtterance
 * @property {string} said
 * @property {number} at
 * @property {[number, number]} window
 * @property {'motion'|'stasis'} query
 * @property {string|null} pointedAt
 * @property {Interaction[]} interactions
 * @property {object[]} [network]
 * @property {object[]} [console]
 * @property {Delta[]} deltas
 * @property {Held[]} held
 * @property {{node: string, prop: string, ticks: number}[]} [ambientSuppressed]
 */

/**
 * Page-clock fit: wall = a*elapsed + b.
 * @typedef {object} FittedClock
 * @property {number} a
 * @property {number} b
 * @property {number|null} residualMs
 * @property {number} n
 * @property {number} [driftPpm]
 */

/**
 * @typedef {object} MirrorNode
 * @property {string} tag
 * @property {Record<string, string>} attrs
 * @property {number|null} parent
 */

/**
 * rrweb event as JSON. The stream is untyped on disk; readers pick fields.
 * @typedef {any} RrwebEvent
 */

/**
 * @typedef {object} MicSegment
 * @property {string} file
 * @property {object} [device]
 * @property {number} [startedWall]
 * @property {number} [endedWall]
 * @property {number} [ticks]
 * @property {number} [bytes]
 * @property {string} [ffmpeg]
 */

export {}
