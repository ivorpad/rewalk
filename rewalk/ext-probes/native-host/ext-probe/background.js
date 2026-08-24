// Minimal MV3 background service worker — Risk-3 probe.
//
// On install (which is what --load-extension triggers) connect to the native
// messaging host and ask it to capture 2s of the default microphone. Whatever
// the host reports comes back on the port; we log it. The host also writes a
// result.json regardless, so the verdict survives even if this SW is torn down.

const HOST = 'com.rewalk.probe'

function capture(trigger) {
  console.log('[rewalk-probe] connecting to', HOST, 'trigger=', trigger)
  let port
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    console.log('[rewalk-probe] connectNative threw:', e && e.message)
    return
  }
  port.onMessage.addListener((msg) => {
    console.log('[rewalk-probe] host reply:', JSON.stringify(msg))
  })
  port.onDisconnect.addListener(() => {
    console.log('[rewalk-probe] host disconnected:', chrome.runtime.lastError && chrome.runtime.lastError.message)
  })
  port.postMessage({ cmd: 'capture', trigger, at: 'sw' })
}

chrome.runtime.onInstalled.addListener(() => capture('onInstalled'))
chrome.runtime.onStartup.addListener(() => capture('onStartup'))
// Also try immediately on SW evaluation, in case the install event was missed.
capture('sw-eval')
