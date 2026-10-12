// RGBA8 缓冲读写：把人像置信度 mask 与原图逐像素合成为透明背景图
// 约定：PixelBuffer 行 0 = 图像顶部（与 ctx.render(toBitmap:) 的实际写入顺序一致）
import AppKit
import CoreImage
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("E:\(message)\n".utf8))
    exit(3)
}

struct PixelBuffer {
    let width: Int
    let height: Int
    let stride: Int
    var bytes: [UInt8]

    func index(_ x: Int, _ yFromTop: Int) -> Int {
        yFromTop * stride + x * 4
    }

    // 置信度/灰度通道（mask 缓冲用）
    func r(_ x: Int, _ yFromTop: Int) -> Int { Int(bytes[index(x, yFromTop)]) }
}

func renderRGBA8(_ ctx: CIContext, _ image: CIImage, _ extent: CGRect) -> PixelBuffer? {
    let w = Int(extent.width.rounded())
    let h = Int(extent.height.rounded())
    guard w > 0, h > 0 else { return nil }
    let rowBytes = w * 4
    var bytes = [UInt8](repeating: 0, count: rowBytes * h)
    let space = CGColorSpace(name: CGColorSpace.sRGB)
    bytes.withUnsafeMutableBytes { raw in
        guard let base = raw.baseAddress else { return }
        ctx.render(
            image, toBitmap: base, rowBytes: rowBytes,
            bounds: CGRect(x: image.extent.origin.x, y: image.extent.origin.y, width: CGFloat(w), height: CGFloat(h)),
            format: .RGBA8, colorSpace: space
        )
    }
    return PixelBuffer(width: w, height: h, stride: rowBytes, bytes: bytes)
}

// mask 拉伸到原图尺寸（置信度写入 R 通道，供逐像素阈值判定）
func renderMask(_ ctx: CIContext, mask: CVPixelBuffer, extent: CGRect) -> PixelBuffer? {
    let maskCI = CIImage(cvPixelBuffer: mask)
    let scaleX = extent.width / max(maskCI.extent.width, 1)
    let scaleY = extent.height / max(maskCI.extent.height, 1)
    let scaled = maskCI.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
    return renderRGBA8(ctx, scaled, extent)
}

// 原图按 mask 置信度抠除背景（背景 RGBA 归零）
func applyMask(_ origin: inout PixelBuffer, _ mask: PixelBuffer, threshold: Int) {
    for y in 0..<min(origin.height, mask.height) {
        for x in 0..<min(origin.width, mask.width) {
            if mask.r(x, y) <= threshold {
                let i = origin.index(x, y)
                origin.bytes[i] = 0
                origin.bytes[i + 1] = 0
                origin.bytes[i + 2] = 0
                origin.bytes[i + 3] = 0
            }
        }
    }
}

// 裁剪区（距顶坐标）导出为 PNG
func cropAndWritePNG(_ buf: PixelBuffer, x: Int, y: Int, w: Int, h: Int, to url: URL) -> Bool {
    guard x >= 0, y >= 0, w > 0, h > 0, x + w <= buf.width, y + h <= buf.height else { return false }
    let rowBytes = w * 4
    var out = [UInt8](repeating: 0, count: rowBytes * h)
    for row in 0..<h {
        let srcStart = row * buf.stride + x * 4
        guard srcStart >= 0, srcStart + rowBytes <= buf.bytes.count else { return false }
        out.replaceSubrange(row * rowBytes..<(row + 1) * rowBytes,
                            with: buf.bytes[srcStart..<srcStart + rowBytes])
    }
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    let data = Data(out)
    guard let provider = CGDataProvider(data: data as CFData),
          let cg = CGImage(
              width: w, height: h,
              bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes,
              space: colorSpace,
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
          ) else { return false }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    do {
        try png.write(to: url)
    } catch {
        fail("write failed: \(error.localizedDescription)")
    }
    return true
}
