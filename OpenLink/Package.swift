// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenLink",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "OpenLink", targets: ["OpenLink"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "OpenLink",
            dependencies: [],
            path: "Sources"
        )
    ]
)
