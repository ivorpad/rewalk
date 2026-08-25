// rewalk-voiced.app — the TCC identity for the voice daemon, now with a face.
//
// Measured 2026-08-24: a LaunchAgent whose program is a bare node binary gets
// digitally-silent microphone capture; the job's program must live inside a
// bundle, and the daemon runs as this app's CHILD (spawn, not exec) so the
// whole tree rolls up to com.rewalk.voiced, which carries
// NSMicrophoneUsageDescription and can be prompted and granted.
//
// Measured 2026-08-25: a faceless mic-holder is unforgivable — a session whose
// stop signal was lost recorded ~10 hours of room audio and nothing on screen
// said so. So the wrapper is a menu bar item now:
//   idle       monochrome mic, ignorable furniture
//   recording  red mic + live elapsed timer next to it — unmissable
//   menu       Stop recording (writes the session's STOP file), Open last
//              replay, Turn mic off/on (kills/respawns the daemon child; while
//              off, sessions degrade to DOM-only exactly as designed), Quit
// State comes from files, same doctrine as everything else here: the daemon
// writes out/.rewalk-status when it starts and stops holding the microphone.
//
//   rewalk-voiced <node> <path/to/bin/daemon.mjs>
import AppKit
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: rewalk-voiced <node> <daemon.mjs> [args...]\n".data(using: .utf8)!)
  exit(2)
}
// REPO/bin/daemon.mjs -> REPO/out
let repo = URL(fileURLWithPath: args[1]).deletingLastPathComponent().deletingLastPathComponent()
let outDir = repo.appendingPathComponent("out")
let statusFile = outDir.appendingPathComponent(".rewalk-status")

struct MicStatus { var recording = false; var dir: String? = nil; var startedWall: Double? = nil }

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
  var item: NSStatusItem!
  var child: Process?
  var micOn = true
  var status = MicStatus()
  let stateLine = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
  let stopItem = NSMenuItem(title: "Stop recording", action: #selector(stopRecording), keyEquivalent: "s")
  let replayItem = NSMenuItem(title: "Open last replay", action: #selector(openReplay), keyEquivalent: "r")
  let toggleItem = NSMenuItem(title: "Turn mic off", action: #selector(toggleMic), keyEquivalent: "")
  let quitItem = NSMenuItem(title: "Quit rewalk voice", action: #selector(quit), keyEquivalent: "q")

  func applicationDidFinishLaunching(_ n: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    menu.delegate = self
    stateLine.isEnabled = false
    for it in [stateLine, .separator(), stopItem, replayItem, .separator(), toggleItem, quitItem] { menu.addItem(it) }
    for it in [stopItem, replayItem, toggleItem, quitItem] { it.target = self }
    item.menu = menu
    spawn()
    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
    tick()
  }

  func spawn() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: args[0])
    p.arguments = Array(args.dropFirst())
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.child = nil
        // The daemon should outlive everything but an explicit "off". If it
        // died on its own, come back — that is what KeepAlive used to do.
        if self.micOn { DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if self.micOn && self.child == nil { self.spawn() } } }
      }
    }
    do { try p.run(); child = p } catch {
      FileHandle.standardError.write("rewalk-voiced: cannot run \(args[0]): \(error)\n".data(using: .utf8)!)
    }
  }

  func readStatus() -> MicStatus {
    guard micOn, child != nil,
          let data = try? Data(contentsOf: statusFile),
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return MicStatus() }
    return MicStatus(recording: j["recording"] as? Bool ?? false,
                     dir: j["dir"] as? String, startedWall: j["startedWall"] as? Double)
  }

  func tick() {
    status = readStatus()
    guard let btn = item.button else { return }
    if !micOn {
      btn.image = symbol("mic.slash")
      btn.contentTintColor = nil
      btn.attributedTitle = NSAttributedString(string: "")
      btn.toolTip = "rewalk voice is OFF — sessions record DOM only"
    } else if status.recording, let t0 = status.startedWall {
      btn.image = App.redDot           // non-template: keeps its color in any menu bar
      btn.contentTintColor = nil
      let s = Int(max(0, Date().timeIntervalSince1970 - t0 / 1000))
      let txt = s >= 3600 ? String(format: " REC %d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                          : String(format: " REC %d:%02d", s / 60, s % 60)
      btn.attributedTitle = NSAttributedString(string: txt, attributes: [
        .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .semibold)])
      btn.toolTip = "rewalk is RECORDING — click to stop"
    } else {
      btn.image = symbol("mic")
      btn.contentTintColor = nil
      btn.attributedTitle = NSAttributedString(string: "")
      btn.toolTip = "rewalk voice: idle, waiting for the toolbar button"
    }
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    tick()
    stateLine.title = !micOn ? "Mic off — sessions record DOM only"
      : status.recording ? "Recording \(URL(fileURLWithPath: status.dir ?? "?").lastPathComponent)"
      : "Idle — start with the Chrome toolbar button"
    stopItem.isEnabled = micOn && status.recording
    toggleItem.title = micOn ? "Turn mic off" : "Turn mic on"
  }

  @objc func stopRecording() {
    guard let dir = status.dir else { return }
    FileManager.default.createFile(atPath: dir + "/STOP", contents: nil)
  }

  @objc func openReplay() {
    let fm = FileManager.default
    var best: (URL, Date)? = nil
    for sub in (try? fm.contentsOfDirectory(at: outDir, includingPropertiesForKeys: nil)) ?? [] {
      let r = sub.appendingPathComponent("replay.html")
      if let m = (try? fm.attributesOfItem(atPath: r.path))?[.modificationDate] as? Date {
        if best == nil || m > best!.1 { best = (r, m) }
      }
    }
    if let b = best { NSWorkspace.shared.open(b.0) }
  }

  @objc func toggleMic() {
    if micOn {
      micOn = false
      child?.terminate()          // daemon exits; nothing holds or can request the mic
      try? FileManager.default.removeItem(at: statusFile)
    } else {
      micOn = true
      if child == nil { spawn() }
    }
    tick()
  }

  @objc func quit() {
    micOn = false
    child?.terminate()
    // Under launchd, exiting alone means KeepAlive brings us back: unload the
    // job. Outside launchd the bootout fails and the plain exit is enough.
    let l = Process()
    l.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    l.arguments = ["bootout", "gui/\(getuid())/com.rewalk.voiced"]
    try? l.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
  }

  static let redDot: NSImage = {
    let img = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
      NSColor.systemRed.setFill()
      NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
      return true
    }
    img.isTemplate = false
    return img
  }()

  func symbol(_ name: String) -> NSImage? {
    let img = NSImage(systemSymbolName: name, accessibilityDescription: "rewalk voice")
    img?.isTemplate = true
    return img
  }
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { delegate.child?.terminate(); exit(0) }
term.resume()
let intr = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intr.setEventHandler { delegate.child?.terminate(); exit(0) }
intr.resume()
app.run()
