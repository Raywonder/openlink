// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenLinkInstaller",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "OpenLinkInstaller", targets: ["OpenLinkInstaller"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "OpenLinkInstaller",
            dependencies: [],
            path: "Sources"
        )
    ]
)
