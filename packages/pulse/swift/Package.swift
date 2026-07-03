// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Pulse",
    platforms: [
        .macOS(.v12), .iOS(.v15),
    ],
    products: [
        .library(name: "Pulse", targets: ["Pulse"]),
    ],
    targets: [
        .target(
            name: "Pulse",
            path: "Sources/Pulse"
        ),
        .testTarget(
            name: "PulseTests",
            dependencies: ["Pulse"],
            path: "Tests/PulseTests",
            resources: [
                // The byte-exact wire fixtures shared with the TS suite.
                .copy("wire.json"),
            ]
        ),
    ]
)
