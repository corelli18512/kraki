// swift-tools-version: 6.0
import PackageDescription

// Manifest tools-version is 6.0 because `iOS .v18` requires it.
// The compiled language mode is pinned to Swift 5 (`.v5`) to keep
// parity with the Xcode project (`SWIFT_VERSION: 5.9` in
// `project.yml`) — so SwiftPM-built and Xcode-built objects use
// identical concurrency/Sendable semantics and don't drift.
//
// Note: `swift test` is not a supported validation path because the
// package is iOS-only (no macOS support); use
// `xcodebuild test -scheme Kraki -destination 'platform=iOS Simulator,...'`
// instead. The `Package.swift` is retained so Xcode and other tools
// that introspect SwiftPM manifests can discover the package.
let package = Package(
    name: "Kraki",
    platforms: [.iOS(.v18)],
    dependencies: [
        .package(url: "https://github.com/raspu/Highlightr.git", exact: "2.3.0"),
    ],
    targets: [
        .target(
            name: "Kraki",
            dependencies: ["Highlightr"],
            path: "Kraki"
        ),
        .testTarget(
            name: "KrakiTests",
            dependencies: ["Kraki"],
            path: "KrakiTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
