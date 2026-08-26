#!/usr/bin/env node
// Write ~/.config/rewalk/config.json if missing. Used by install.sh.
import { ensureConfigFile, configPath } from '../lib/config.mjs'

const dest = process.argv[2] || configPath()
const r = ensureConfigFile(dest)
console.log(r.wrote ? `wrote ${r.path}` : `kept ${r.path}`)
