// Minimal microphone capturer, bundled so macOS will grant it.
//
// The rewalk native host cannot record the microphone: Chrome spawns it as a
// bare `node` process with no Info.plist, so macOS has nothing to attribute a
// TCC grant to and hands back zeroed buffers (measured: peak 0.000000, no
// prompt). The fix, proven by the CopilotAudio bundle in a sibling project, is
// that the capturer must be a real .app bundle with a usage string macOS can
// prompt against. This is that, pared to exactly what rewalk needs: microphone
// only, via AVAudioEngine, resampled to 16k mono int16 — no ScreenCaptureKit,
// so no Screen Recording permission. It writes a growing WAV and stamps
// (audioMs, wall) ticks to stderr, the same clock signal ffmpeg's -progress
// gave the CLI path, so lib/record.mjs fitProgressClock works unchanged.
//
//   rewalk-mic <out.wav>      records until SIGINT/SIGTERM, then fixes the header
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write("usage: rewalk-mic <out.wav>\n".data(using: .utf8)!); exit(2) }
let outPath = args[1]
let rate = 16000.0

FileManager.default.createFile(atPath: outPath, contents: nil)
guard let fh = FileHandle(forWritingAtPath: outPath) else {
  FileHandle.standardError.write("cannot open \(outPath)\n".data(using: .utf8)!); exit(2)
}
func le32(_ v: UInt32) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 4) }
func le16(_ v: UInt16) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 2) }
// 44-byte WAV header with placeholder sizes; fixed up on exit.
var header = Data("RIFF".utf8); header.append(le32(0)); header.append(Data("WAVE".utf8))
header.append(Data("fmt ".utf8)); header.append(le32(16)); header.append(le16(1)); header.append(le16(1))
header.append(le32(UInt32(rate))); header.append(le32(UInt32(rate) * 2)); header.append(le16(2)); header.append(le16(16))
header.append(Data("data".utf8)); header.append(le32(0))
fh.write(header)

var dataBytes: UInt32 = 0
var signalSources: [DispatchSourceSignal] = []
let engine = AVAudioEngine()
let input = engine.inputNode
let hw = input.outputFormat(forBus: 0)
guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
      let conv = AVAudioConverter(from: hw, to: out) else {
  FileHandle.standardError.write("{\"type\":\"error\",\"message\":\"converter init failed\"}\n".data(using: .utf8)!); exit(1)
}
let epoch = Date().timeIntervalSince1970 * 1000
func tick() {
  let audioMs = Double(dataBytes) / 2.0 / rate * 1000.0
  let wall = Date().timeIntervalSince1970 * 1000
  let s = "{\"type\":\"tick\",\"audioMs\":\(Int(audioMs)),\"wall\":\(Int(wall))}\n"
  FileHandle.standardError.write(s.data(using: .utf8)!)
}

input.installTap(onBus: 0, bufferSize: 4096, format: hw) { buffer, _ in
  let cap = AVAudioFrameCount(Double(buffer.frameLength) * rate / hw.sampleRate) + 16
  guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
  var err: NSError?
  var fed = false
  conv.convert(to: outBuf, error: &err) { _, status in
    if fed { status.pointee = .noDataNow; return nil }
    fed = true; status.pointee = .haveData; return buffer
  }
  if let e = err { FileHandle.standardError.write("{\"type\":\"error\",\"message\":\"\(e.localizedDescription)\"}\n".data(using: .utf8)!); return }
  guard let ch = outBuf.int16ChannelData, outBuf.frameLength > 0 else { return }
  let n = Int(outBuf.frameLength)
  let d = Data(bytes: ch[0], count: n * 2)
  fh.write(d); dataBytes += UInt32(n * 2)
}

func finalize() {
  engine.stop(); input.removeTap(onBus: 0)
  // Fix up RIFF + data sizes now that we know them.
  try? fh.seek(toOffset: 4);  fh.write(le32(36 + dataBytes))
  try? fh.seek(toOffset: 40); fh.write(le32(dataBytes))
  try? fh.close()
  FileHandle.standardError.write("{\"type\":\"done\",\"bytes\":\(dataBytes)}\n".data(using: .utf8)!)
  exit(0)
}
// DispatchSource, not signal(): a C signal handler cannot capture finalize().
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
for sig in [SIGINT, SIGTERM] {
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { finalize() }
  src.resume()
  signalSources.append(src)
}

do {
  try engine.start()
  FileHandle.standardError.write("{\"type\":\"started\",\"sampleRate\":\(Int(rate))}\n".data(using: .utf8)!)
} catch {
  FileHandle.standardError.write("{\"type\":\"error\",\"message\":\"\(error.localizedDescription)\"}\n".data(using: .utf8)!); exit(1)
}
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in tick() }
RunLoop.main.run()
