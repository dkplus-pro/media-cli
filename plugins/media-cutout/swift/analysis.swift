// 人像分析：mask 包围盒 + 姿态/人脸关键点换算为距顶像素坐标
import Foundation
import Vision



// mask 置信度扫描出人物纵向范围
func maskRows(_ mask: PixelBuffer, threshold: Int) -> (top: Int, bottom: Int)? {
    var top = -1
    var bottom = -1
    for y in 0..<mask.height {
        var hit = false
        var x = 0
        while x < mask.width {
            if mask.r(x, y) > threshold { hit = true; break }
            x += 3
        }
        if hit {
            if top < 0 { top = y }
            bottom = y
        }
    }
    return top >= 0 ? (top, bottom) : nil
}

// 条带内（可选列窗口）的 mask 紧凑包围盒
func tightBox(_ band: Band, _ mask: PixelBuffer, threshold: Int) -> (minX: Int, minY: Int, maxX: Int, maxY: Int)? {
    let cols = band.columns ?? (left: 0, right: mask.width - 1)
    var minX = Int.max
    var maxX = -1
    var minY = -1
    var maxY = -1
    for y in max(0, band.top)...min(mask.height - 1, band.bottom) {
        var x = max(0, cols.left)
        let stop = min(mask.width - 1, cols.right)
        while x <= stop {
            if mask.r(x, y) > threshold {
                if minY < 0 { minY = y }
                maxY = y
                minX = min(minX, x)
                maxX = max(maxX, x)
                break
            }
            x += 1
        }
        if x <= stop {
            var back = stop
            while back > x {
                if mask.r(back, y) > threshold { maxX = max(maxX, back); break }
                back -= 1
            }
        }
    }
    guard minY >= 0, maxX >= minX else { return nil }
    return (minX, minY, maxX, maxY)
}

// Vision 归一化坐标（原点左下）→ 距顶像素坐标
func toPixel(_ p: CGPoint, _ width: Int, _ height: Int) -> (x: Int, y: Int) {
    let px = Int((Double(p.x) * Double(width)).rounded())
    let py = Int(((1 - Double(p.y)) * Double(height)).rounded())
    return (px, py)
}

func buildPersonModel(
    mask: PixelBuffer,
    rows: (top: Int, bottom: Int),
    poses: [VNHumanBodyPoseObservation],
    faces: [VNFaceObservation]
) -> PersonModel {
    let width = mask.width
    let height = mask.height

    // 多人时选纵向跨度最大（最完整）的那个人
    var best: (joints: [VNHumanBodyPoseObservation.JointName: (x: Int, y: Int)], span: Int)?
    for pose in poses where pose.confidence > 0.3 {
        guard let points = try? pose.recognizedPoints(.all) else { continue }
        var joints: [VNHumanBodyPoseObservation.JointName: (x: Int, y: Int)] = [:]
        for (name, point) in points {
            guard point.confidence > 0.3 else { continue }
            joints[name] = toPixel(point.location, width, height)
        }
        guard joints.count >= 3 else { continue }
        let ys = joints.values.map(\.y)
        let span = (ys.max() ?? 0) - (ys.min() ?? 0)
        if best == nil || span > best!.span { best = (joints, span) }
    }
    let joints = best?.joints ?? [:]

    var face: (top: Int, bottom: Int, left: Int, right: Int)?
    if let f = faces.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
        let rect = f.boundingBox
        let left = Int(rect.minX * Double(width))
        let right = Int(rect.maxX * Double(width))
        let top = Int((1 - rect.maxY) * Double(height))
        let bottom = Int((1 - rect.minY) * Double(height))
        face = (top, bottom, left, right)
    }

    return PersonModel(
        width: width, height: height,
        maskTop: rows.top, maskBottom: rows.bottom,
        joints: joints, face: face
    )
}
