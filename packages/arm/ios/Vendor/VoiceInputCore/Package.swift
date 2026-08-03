// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoiceInputCore",
    platforms: [
        .macOS(.v13),
        .iOS(.v18),
    ],
    products: [
        .library(name: "VoiceInputCore", targets: ["VoiceInputCore"]),
    ],
    targets: [
        .target(
            name: "VoiceInputCore",
            linkerSettings: [.linkedFramework("AVFoundation")]
        ),
        .testTarget(
            name: "VoiceInputCoreTests",
            dependencies: ["VoiceInputCore"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
