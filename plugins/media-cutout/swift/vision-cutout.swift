// vision-cutout — 本地抠图工具（macOS 14+）
// 用法: vision-cutout <input> <output> <padding>
//   padding >= 0: 裁剪到主体包围盒并外扩 padding 像素（clamp 画布）
//   padding < 0 : 不裁剪，保留原始画布尺寸
// stderr 以 "E:" 开头的行表示可读错误；退出码非 0 表示失败。
import AppKit
import CoreImage
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("E:\(message)\n".utf8))
    exit(3)
}

let args = CommandLine.arguments
guard args.count >= 4, let padding = Int(args[3]) else {
    fail("usage: vision-cutout <input> <output> <padding>")
}
let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard let image = CIImage(contentsOf: inputURL) else {
    fail("cannot read image: \(args[1])")
}
let extent = image.extent

let handler = VNImageRequestHandler(ciImage: image)
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error.localizedDescription)")
}
guard let observation = request.results?.first else {
    fail("no foreground subject found")
}
do {
    // 直接生成主体带 alpha、背景透明的合成图（croppedToInstancesExtent=false 保持整画布）
    let maskedBuffer = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: false
    )
    let composited = CIImage(cvPixelBuffer: maskedBuffer)

    let context = CIContext()
    guard var cg = context.createCGImage(composited, from: extent) else {
        fail("render failed")
    }

    if padding >= 0 {
        // 以 RGBA8 重新渲染一份用于扫描 alpha 求主体包围盒
        let scanContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        guard let scanCG = scanContext.createCGImage(composited, from: extent, format: .RGBA8, colorSpace: nil) else {
            fail("render (scan) failed")
        }
        let width = scanCG.width
        let height = scanCG.height
        let bytesPerRow = scanCG.bytesPerRow
        guard let dataProvider = scanCG.dataProvider,
              let data = CFDataGetBytePtr(dataProvider.data) else {
            fail("pixel data unavailable")
        }
        let pixels = Array(UnsafeBufferPointer<UInt8>(start: data, count: bytesPerRow * height))
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            let row = y * bytesPerRow
            for x in 0..<width {
                if pixels[row + x * 4 + 3] > 8 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { fail("no foreground subject found") }
        let cropX = max(0, minX - padding)
        let cropY = max(0, minY - padding)
        let cropW = min(width, maxX + 1 + padding) - cropX
        let cropH = min(height, maxY + 1 + padding) - cropY
        guard let cropped = cg.cropping(to: CGRect(x: cropX, y: cropY, width: cropW, height: cropH)) else {
            fail("crop failed")
        }
        cg = cropped
    }

    let rep = NSBitmapImageRep(cgImage: cg)
    guard let png = rep.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
        fail("png encode failed")
    }
    do {
        try png.write(to: outputURL)
    } catch {
        fail("write failed: \(error.localizedDescription)")
    }
} catch {
    fail("mask failed: \(error.localizedDescription)")
}
