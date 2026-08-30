import AppKit

enum EnergySuggestionReason {
    case battery
    case sustainedActivity

    var message: String {
        switch self {
        case .battery:
            return "你的 Mac 已切换为电池供电。SuperIsland 可以减少后台刷新并暂停非必要的扩展工作，直到你插回电源。"
        case .sustainedActivity:
            return "SuperIsland 一直在进行持续的后台刷新工作。低电量模式可以暂停非必要的刷新，直到你再次需要它。"
        }
    }
}

@MainActor
final class EnergySuggestionPresenter {
    static let shared = EnergySuggestionPresenter()

    private let lastPromptKey = "energy.lowPowerSuggestion.lastPromptAt"
    private var isShowing = false

    private init() {}

    func suggestLowPower(reason: EnergySuggestionReason) {
        let appState = AppState.shared
        guard appState.energyMode != .lowPower else { return }
        guard !appState.lowPowerSuggestionDoNotAskAgain else { return }
        guard !isShowing else { return }

        let lastPrompt = UserDefaults.standard.double(forKey: lastPromptKey)
        if lastPrompt > 0, Date().timeIntervalSince1970 - lastPrompt < 24 * 60 * 60 {
            return
        }

        isShowing = true
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastPromptKey)

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let alert = NSAlert()
            alert.messageText = "是否使用低电量模式？"
            alert.informativeText = reason.message
            alert.alertStyle = .informational
            alert.addButton(withTitle: "启用低电量模式")
            alert.addButton(withTitle: "暂时不用")
            alert.addButton(withTitle: "不再询问")

            let response = alert.runModal()
            switch response {
            case .alertFirstButtonReturn:
                AppState.shared.energyMode = .lowPower
            case .alertThirdButtonReturn:
                AppState.shared.lowPowerSuggestionDoNotAskAgain = true
            default:
                break
            }
            self.isShowing = false
        }
    }
}
