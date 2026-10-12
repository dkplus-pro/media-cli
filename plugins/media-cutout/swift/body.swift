// 人体部位推导：Vision 姿态关键点 + 人脸框 + 人像 mask，换算为「距顶像素」的横向条带
import Foundation
import Vision

struct PersonModel {
    let width: Int
    let height: Int
    let maskTop: Int
    let maskBottom: Int
    let joints: [VNHumanBodyPoseObservation.JointName: (x: Int, y: Int)]
    let face: (top: Int, bottom: Int, left: Int, right: Int)?

    var bodyHeight: Int { max(1, maskBottom - maskTop + 1) }
    var maxDim: Int { max(width, height) }

    func joint(_ name: VNHumanBodyPoseObservation.JointName) -> (x: Int, y: Int)? {
        joints[name]
    }

    // 左右同名关节的平均行（水平线），缺一侧则用另一侧
    func level(_ left: VNHumanBodyPoseObservation.JointName, _ right: VNHumanBodyPoseObservation.JointName) -> Int? {
        let a = joints[left]?.y
        let b = joints[right]?.y
        if let a, let b { return (a + b) / 2 }
        return a ?? b
    }

    var shoulderWidth: Int {
        if let l = joints[.leftShoulder]?.x, let r = joints[.rightShoulder]?.x {
            return max(1, abs(l - r))
        }
        // 肩部关键点缺失（远景/截断）时按人体高度估肩宽，避免列窗吞掉整张图
        return max(1, bodyHeight / 5)
    }

    // 以人体为中心的列窗口，避免多人图把邻座一起裁进来
    var columnWindow: (left: Int, right: Int)? {
        guard let cx = joints[.root]?.x ?? joints[.leftShoulder]?.x ?? joints[.rightShoulder]?.x else { return nil }
        let half = Int(Double(shoulderWidth) * 1.8)
        return (max(0, cx - half), min(width - 1, cx + half))
    }
}

struct Band {
    let top: Int
    let bottom: Int
    let columns: (left: Int, right: Int)?
}

// 部位条带；返回 nil 表示关键信息不足，判为未匹配
func partBand(_ part: String, _ p: PersonModel) -> Band? {
    let shoulder = p.level(.leftShoulder, .rightShoulder)
    let hip = p.level(.leftHip, .rightHip)
    let knee = p.level(.leftKnee, .rightKnee)
    let ankle = p.level(.leftAnkle, .rightAnkle)
    let window = p.columnWindow

    switch part {
    case "head":
        guard let face = p.face else { return nil }
        let faceH = max(1, face.bottom - face.top)
        let hair = max(2, faceH / 6)
        // 头部列窗以人脸框为基准（合影下不会被肩宽窗口带到邻座）
        let cols = (left: max(0, face.left - faceH / 2), right: min(p.width - 1, face.right + faceH / 2))
        return Band(top: max(0, face.top - hair), bottom: min(shoulder ?? face.bottom, p.height - 1), columns: cols)
    case "hat":
        guard let face = p.face else { return nil }
        let faceH = max(1, face.bottom - face.top)
        let brim = face.top + faceH / 3
        let crown = max(0, face.top - faceH)
        guard brim > crown else { return nil }
        let cols = (left: max(0, face.left - faceH / 3), right: min(p.width - 1, face.right + faceH / 3))
        return Band(top: crown, bottom: brim, columns: cols)
    case "top":
        guard let s = shoulder, let h = hip, h > s else { return nil }
        return Band(top: s, bottom: h, columns: window)
    case "bottom":
        guard let h = hip else { return nil }
        return Band(top: h, bottom: min(ankle ?? p.maskBottom, p.height - 1), columns: window)
    case "outfit":
        guard let s = shoulder else { return nil }
        let end = max(hip ?? s + 1, ankle ?? p.maskBottom)
        guard end > s else { return nil }
        return Band(top: s, bottom: min(end, p.height - 1), columns: window)
    case "gloves":
        return handBand(p, .leftElbow, .leftWrist, window) ?? handBand(p, .rightElbow, .rightWrist, window)
    case "shoes":
        guard let a = ankle else { return nil }
        return Band(top: a, bottom: p.maskBottom, columns: window)
    case "socks":
        guard let a = ankle else { return nil }
        let shin = knee.map { max(4, (a - $0) * 2 / 5) } ?? max(4, p.bodyHeight / 20)
        return Band(top: max(0, a - shin), bottom: min(p.maskBottom, a + shin / 2), columns: window)
    default:
        return nil
    }
}

// 手部条带：以肘→腕连线长度为尺度，围绕手腕取一小段
private func handBand(
    _ p: PersonModel,
    _ elbow: VNHumanBodyPoseObservation.JointName,
    _ wrist: VNHumanBodyPoseObservation.JointName,
    _ window: (left: Int, right: Int)?
) -> Band? {
    guard let e = p.joint(elbow), let w = p.joint(wrist) else { return nil }
    let reach = max(4, abs(w.y - e.y))
    let cols = (left: max(0, min(e.x, w.x) - reach / 2), right: min(p.width - 1, max(e.x, w.x) + reach / 2))
    return Band(top: max(0, w.y - reach), bottom: min(p.height - 1, w.y + reach / 2), columns: cols)
}
