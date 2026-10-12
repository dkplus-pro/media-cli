// vision-part-crop — 人体部位裁剪工具（macOS 14+）
// 用法: vision-part-crop <input> <output> <part> <padding>
//   part: head|hat|top|bottom|outfit|gloves|shoes|socks
//   padding >= 0：部位包围盒向外扩边（clamp 画布）
// 部位由人像分割 mask + 人体姿态关键点 + 人脸框推导；关键点对不可见（截断/遮挡）时判为未匹配。
// stderr 以 "E:" 开头的行表示可读错误；退出码非 0 表示失败。
import CoreImage
import Foundation
import Vision

let supportedParts = ["head", "hat", "top", "bottom", "outfit", "gloves", "shoes", "socks"]
let maskThreshold = 127

func runPartCrop(_ args: [String]) {
    guard args.count >= 5, let padding = Int(args[4]) else {
        fail("usage: vision-part-crop <input> <output> <part> <padding>")
    }
    let part = args[3]
    guard supportedParts.contains(part) else { fail("unsupported part: \(part)") }

    // EXIF 方向直接烘焙进像素，保证 mask/姿态/输出三者同一坐标系
    guard let image = CIImage(
        contentsOf: URL(fileURLWithPath: args[1]),
        options: [.applyOrientationProperty: true]
    )?.oriented(forExifOrientation: 1) else {
        fail("cannot read image: \(args[1])")
    }
    let outputURL = URL(fileURLWithPath: args[2])

    let seg = VNGeneratePersonSegmentationRequest()
    seg.qualityLevel = .accurate
    let pose = VNDetectHumanBodyPoseRequest()
    let face = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(ciImage: image)
    do {
        try handler.perform([seg, pose, face])
    } catch {
        fail("vision request failed: \(error.localizedDescription)")
    }
    guard let maskBuffer = seg.results?.first?.pixelBuffer else { fail("no person in image") }

    let extent = image.extent
    let ctx = CIContext()
    guard let origin = renderRGBA8(ctx, image, extent) else { fail("render origin failed") }
    guard let mask = renderMask(ctx, mask: maskBuffer, extent: extent) else { fail("render mask failed") }
    guard let rows = maskRows(mask, threshold: maskThreshold) else { fail("no person in image") }

    let model = buildPersonModel(
        mask: mask, rows: rows,
        poses: pose.results ?? [],
        faces: face.results ?? []
    )
    guard let band = partBand(part, model) else { fail("'\(part)' not detected") }
    guard let box = tightBox(band, mask, threshold: maskThreshold) else { fail("'\(part)' not detected") }
    // 鞋/袜条带高度阈值：过低说明该部位不在画面内
    let height = box.maxY - box.minY + 1
    if part == "shoes", height < max(2, model.maxDim / 100) { fail("'\(part)' not detected") }
    if part == "socks", height < max(4, model.bodyHeight / 40) { fail("'\(part)' not detected") }

    var masked = origin
    applyMask(&masked, mask, threshold: maskThreshold)

    let pad = max(0, padding)
    let cropX = max(0, box.minX - pad)
    let cropY = max(0, box.minY - pad)
    let cropW = min(mask.width, box.maxX + 1 + pad) - cropX
    let cropH = min(mask.height, box.maxY + 1 + pad) - cropY
    guard cropAndWritePNG(masked, x: cropX, y: cropY, w: cropW, h: cropH, to: outputURL) else {
        fail("crop failed")
    }
}
