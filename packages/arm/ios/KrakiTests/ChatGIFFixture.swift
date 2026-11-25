import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Animated GIFs and still images written with ImageIO for the chat image
/// tests (iOS and Mac).
enum ChatGIFFixture {
    /// One solid colour a frame (red, green, blue, … by index).
    static func gif(
        frames: Int,
        width: Int = 40,
        height: Int = 20,
        delays: [Double]? = nil,
        loopCount: Int? = 0,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, frames, nil),
            file: file, line: line)
        if let loopCount {
            CGImageDestinationSetProperties(destination, [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: loopCount],
            ] as CFDictionary)
        }
        for index in 0..<frames {
            let delay = delays?[index] ?? 0.1
            CGImageDestinationAddImage(destination, try solid(index, width: width, height: height), [
                kCGImagePropertyGIFDictionary: [
                    kCGImagePropertyGIFDelayTime: delay,
                    kCGImagePropertyGIFUnclampedDelayTime: delay,
                ],
            ] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination), file: file, line: line)
        return data as Data
    }

    static func png(width: Int = 40, height: Int = 20) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try solid(0, width: width, height: height), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static let colors: [(CGFloat, CGFloat, CGFloat)] = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 1, 1), (1, 0, 1)]

    static func solid(_ index: Int, width: Int, height: Int) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let color = colors[index % colors.count]
        context.setFillColor(red: color.0, green: color.1, blue: color.2, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }

    /// The colour at the centre of `image` (0…1 per channel).
    static func centerColor(_ image: CGImage) -> (CGFloat, CGFloat, CGFloat) {
        var pixel = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpaceCreateDeviceRGB()
        pixel.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            context.draw(image, in: CGRect(x: -CGFloat(image.width) / 2, y: -CGFloat(image.height) / 2,
                                           width: CGFloat(image.width), height: CGFloat(image.height)))
        }
        return (CGFloat(pixel[0]) / 255, CGFloat(pixel[1]) / 255, CGFloat(pixel[2]) / 255)
    }

    static func file(_ data: Data, mimeType: String = "image/gif", label: String? = nil) -> ChatImageFile {
        ChatImageFile(id: "fixture-\(UUID().uuidString)", data: data, mimeType: mimeType, label: label)
    }
}
