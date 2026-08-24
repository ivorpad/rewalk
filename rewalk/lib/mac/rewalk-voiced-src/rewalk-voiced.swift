// rewalk-voiced.app — a TCC identity for the voice daemon.
//
// Measured 2026-08-24: a LaunchAgent whose program is a bare node binary gets
// digitally-silent microphone capture, even though the SAME rewalk-mic.app
// records real audio when launched via LaunchServices. TCC resolves the
// responsible process to the launchd job, and a job with no bundle has no
// Info.plist to prompt against — the identical failure mode as the
// Chrome-spawned native host, one level up.
//
// So the job's program must live inside a bundle. This wrapper is that bundle:
// it SPAWNS its arguments as a child (spawn, not exec — an exec would replace
// the process image with node and lose the bundle identity) and forwards
// signals, so the whole daemon tree, rewalk-mic.app included, rolls up to
// com.rewalk.voiced, which carries NSMicrophoneUsageDescription and can be
// prompted and granted.
//
//   rewalk-voiced <executable> [args...]
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 1 else {
  FileHandle.standardError.write("usage: rewalk-voiced <executable> [args...]\n".data(using: .utf8)!)
  exit(2)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: args[0])
child.arguments = Array(args.dropFirst())
child.standardInput = FileHandle.standardInput
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM)
term.setEventHandler { child.terminate() }
term.resume()
let int = DispatchSource.makeSignalSource(signal: SIGINT)
int.setEventHandler { child.interrupt() }
int.resume()

do { try child.run() } catch {
  FileHandle.standardError.write("rewalk-voiced: cannot run \(args[0]): \(error)\n".data(using: .utf8)!)
  exit(3)
}
child.waitUntilExit()
exit(child.terminationStatus)
