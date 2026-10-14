// vision-faces — 本地人脸检测（macOS 14+，Apple Vision，离线零下载）
// 用法: vision-faces <input>
// stdout: 一行 JSON
//   {"width":2048,"height":2048,"faces":[{"x":..,"y":..,"w":..,"h":..,"confidence":0.84,"quality":null}]}
// 坐标为**像素 + 左上原点**，且 EXIF 方向已应用（与 media-cli 全仓像素坐标约定一致）。
// Vision 的 boundingBox 是「归一化 + 左下原点」，故 y = (1 - bb.maxY) * H。
// 检出 0 张脸不算失败：faces 为空数组、退出码 0（上层按 E_NO_FACE_DETECTED 警告处理）。
// 失败：stderr 输出 "E:<message>"，退出码 3（Node 侧映射 E_PROVIDER_ERROR, details.source = "vision"）。
import AppKit
import CoreImage
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("E:\(message)\n".utf8))
    exit(3)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: vision-faces <input>")
}
let inputURL = URL(fileURLWithPath: args[1])

// applyOrientationProperty 让 CIImage 直接落到「摆正后」的像素坐标系，
// 这样 extent 与 JS 侧 sharp(...).rotate() 的坐标系一致，白圆才不会偏。
guard let ciImage = CIImage(contentsOf: inputURL, options: [.applyOrientationProperty: true]) else {
    fail("cannot read image: \(args[1])")
}
let extent = ciImage.extent
guard extent.width > 0, extent.height > 0 else {
    fail("image has zero size: \(args[1])")
}
let width = extent.width
let height = extent.height

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
let request = VNDetectFaceRectanglesRequest()
// Revision3 对侧脸更稳；老系统不支持就忽略（try? 语义：赋值失败无副作用）
if #available(macOS 11.0, *) {
    request.revision = VNDetectFaceRectanglesRequestRevision3
}
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error.localizedDescription)")
}

func round3(_ v: Double) -> Double {
    return v.isFinite ? ((v * 1000).rounded() / 1000) : 0
}

// JSONSerialization 会把 Double 打成 0.83999999999999997 这种全精度形态；
// 走 NSDecimalNumber(%.3f) 才能输出 stdout 里可读的 0.84（这是给 AI 读的数据）。
func num(_ v: Double) -> NSDecimalNumber {
    return NSDecimalNumber(string: String(format: "%.3f", round3(v)))
}

var faces: [[String: Any]] = []
for observation in request.results ?? [] {
    let bb = observation.boundingBox
    faces.append([
        "x": num(Double(bb.minX) * Double(width)),
        "y": num((1.0 - Double(bb.maxY)) * Double(height)),  // ← Y 轴翻转：左下原点 → 左上原点
        "w": num(Double(bb.width) * Double(width)),
        "h": num(Double(bb.height) * Double(height)),
        "confidence": num(Double(observation.confidence)),
        // faceCaptureQuality 在本 SDK 是 Float?（Revision3 下常为 nil），缺失写 null 而不是省略键
        "quality": observation.faceCaptureQuality.map { num(Double($0)) } ?? NSNull(),
    ])
}

let payload: [String: Any] = [
    "width": num(Double(width)),
    "height": num(Double(height)),
    "faces": faces,
]

guard
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
else {
    fail("json encode failed")
}
FileHandle.standardOutput.write(Data("\(text)\n".utf8))
exit(0)
