// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CoinfraCrypto",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CoinfraCrypto", targets: ["CoinfraCrypto"]),
    ],
    targets: [
        .target(name: "CoinfraCrypto"),
    ]
)
