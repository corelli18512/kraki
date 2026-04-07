// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Kraki",
    platforms: [.iOS(.v17), .macOS(.v14)],
    targets: [
        .target(
            name: "Kraki",
            path: "Kraki",
            exclude: []
        ),
        .testTarget(
            name: "KrakiTests",
            dependencies: ["Kraki"],
            path: "KrakiTests"
        ),
    ]
)
