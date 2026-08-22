// Which microphone is the system default, and tell me when that changes.
//
// Hardcoding an ffmpeg avfoundation index is wrong twice over: the indices
// shift when hardware comes and goes, and the device a person expects to be
// recorded is whichever one they picked in System Settings, not whichever one
// happened to be fourth in a list. This asks CoreAudio, which is the only thing
// that actually knows.
//
//   default-input            print the current default input as JSON, exit
//   default-input --watch    print it now, then again on every change
//
// Windows will need its own implementation of the same two lines of output.
// The JSON shape is the contract; this file is the macOS half of it.

import CoreAudio
import Foundation

func stringProperty(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var value: CFString? = nil
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(device, &addr, 0, nil, &size, $0)
  }
  guard status == noErr, let v = value else { return nil }
  return v as String
}

/// Input channel count, so a device with no input capability is never reported.
func inputChannels(_ device: AudioDeviceID) -> Int {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultInputDevice() -> AudioDeviceID? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device)
  return status == noErr && device != 0 ? device : nil
}

func escape(_ s: String) -> String {
  var out = ""
  for c in s.unicodeScalars {
    switch c {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    default:
      if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
    }
  }
  return out
}

func report() {
  guard let d = defaultInputDevice() else {
    print("{\"ok\":false,\"reason\":\"no default input device\"}")
    fflush(stdout)
    return
  }
  let name = stringProperty(d, kAudioObjectPropertyName) ?? "unknown"
  let uid = stringProperty(d, kAudioDevicePropertyDeviceUID) ?? ""
  let ch = inputChannels(d)
  print("{\"ok\":true,\"id\":\(d),\"name\":\"\(escape(name))\",\"uid\":\"\(escape(uid))\",\"inputChannels\":\(ch)}")
  fflush(stdout)
}

report()

if CommandLine.arguments.contains("--watch") {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  // A property listener rather than a poll: switching microphones mid-session
  // should be noticed in the moment it happens, not up to a poll interval later.
  let status = AudioObjectAddPropertyListenerBlock(
    AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main
  ) { _, _ in report() }
  if status != noErr {
    FileHandle.standardError.write("failed to register listener: \(status)\n".data(using: .utf8)!)
    exit(1)
  }
  // Exit cleanly when the parent closes our stdout rather than lingering.
  signal(SIGPIPE, SIG_DFL)
  dispatchMain()
}
