// Lists on-screen windows (front to back) without Screen Recording permission: owner, pid, layer, bounds.
// Usage: windows <owner-substring>   (e.g. "Electron")
import CoreGraphics
import Foundation
let filter = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for (i, w) in list.enumerated() {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  if !filter.isEmpty && !owner.contains(filter) { continue }
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("z=\(i) owner=\(owner) pid=\(pid) layer=\(layer) bounds=\(b["X"] ?? 0),\(b["Y"] ?? 0) \(b["Width"] ?? 0)x\(b["Height"] ?? 0)")
}
