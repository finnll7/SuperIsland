import Foundation

struct NowPlayingSnapshot {
    let providerID: String
    let title: String
    let artist: String
    let album: String
    let duration: TimeInterval
    let elapsedTime: TimeInterval
    let playbackRate: Double
    let isPlaying: Bool
    let sourceName: String
    let bundleIdentifier: String
    let albumArtist: String
    let artworkURL: String?
    let trackIdentifier: String
    let isLocalFile: Bool
    let browserTabURL: String
    let capturedAt: Date
}

enum NowPlayingProviderStatus: Equatable {
    case idle
    case checking(String)
    case playing(String)
    case paused(String)
    case stale(String)
    case browserDisabled
    case permissionNeeded(String)
    case unavailable(String)

    var title: String {
        switch self {
        case .idle:
            return "没有正在播放"
        case .checking(let source):
            return "正在检查 \(source)"
        case .playing(let source):
            return source
        case .paused(let source):
            return "\(source) 已暂停"
        case .stale(let source):
            return "\(source) 上次播放"
        case .browserDisabled:
            return "浏览器检测已关闭"
        case .permissionNeeded(let source):
            return "\(source) 需要权限"
        case .unavailable(let source):
            return "\(source) 不可用"
        }
    }

    var subtitle: String {
        switch self {
        case .idle:
            return "开始播放以在此处固定控件。"
        case .checking:
            return "正在查找活动的媒体。"
        case .playing:
            return "播放控件已就绪。"
        case .paused:
            return "准备好后恢复播放。"
        case .stale:
            return "最后已知曲目会短暂保留在此。"
        case .browserDisabled:
            return "启用浏览器媒体检测以支持 Chrome 播放。"
        case .permissionNeeded:
            return "允许自动化访问以及浏览器中来自 Apple Events 的 JavaScript。"
        case .unavailable:
            return "打开应用并开始播放，然后重试。"
        }
    }
}

struct NowPlayingBrowserTarget: Identifiable, Equatable {
    let id: String
    let displayName: String
    let applicationName: String
    let processName: String
}

enum NowPlayingProviderError: Error {
    case unsupported
}

@MainActor
protocol NowPlayingProvider {
    var id: String { get }
    var displayName: String { get }
    var requiresPermission: Bool { get }
    func currentSnapshot() async -> NowPlayingSnapshot?
    func playPause() async throws
    func nextTrack() async throws
    func previousTrack() async throws
}

@MainActor
struct NowPlayingScriptProvider: NowPlayingProvider {
    let id: String
    let displayName: String
    let requiresPermission: Bool
    let currentSnapshotHandler: () async -> NowPlayingSnapshot?
    let playPauseHandler: () async throws -> Void
    let nextTrackHandler: () async throws -> Void
    let previousTrackHandler: () async throws -> Void

    init(
        id: String,
        displayName: String,
        requiresPermission: Bool,
        currentSnapshot: @escaping () async -> NowPlayingSnapshot?,
        playPause: @escaping () async throws -> Void = { throw NowPlayingProviderError.unsupported },
        nextTrack: @escaping () async throws -> Void = { throw NowPlayingProviderError.unsupported },
        previousTrack: @escaping () async throws -> Void = { throw NowPlayingProviderError.unsupported }
    ) {
        self.id = id
        self.displayName = displayName
        self.requiresPermission = requiresPermission
        self.currentSnapshotHandler = currentSnapshot
        self.playPauseHandler = playPause
        self.nextTrackHandler = nextTrack
        self.previousTrackHandler = previousTrack
    }

    func currentSnapshot() async -> NowPlayingSnapshot? {
        await currentSnapshotHandler()
    }

    func playPause() async throws {
        try await playPauseHandler()
    }

    func nextTrack() async throws {
        try await nextTrackHandler()
    }

    func previousTrack() async throws {
        try await previousTrackHandler()
    }
}
