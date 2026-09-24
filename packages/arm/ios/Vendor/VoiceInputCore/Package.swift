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
            name: "VoiceAudioSafety",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio", .when(platforms: [.macOS])),
            ]
        ),
        .target(
            name: "VoiceInputCore",
            dependencies: ["VoiceAudioSafety"],
            linkerSettings: [.linkedFramework("AVFoundation")]
        ),
        .target(
            name: "VoiceAudioSafetyTestSupport",
            path: "Tests/VoiceAudioSafetyTestSupport"
        ),
        .testTarget(
            name: "VoiceInputCoreTests",
            dependencies: ["VoiceInputCore", "VoiceAudioSafety", "VoiceAudioSafetyTestSupport"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
