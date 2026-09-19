import Foundation

/// SuperIsland 的本地 AI 提供方凭据文件（只读）。
///
/// 路径：`~/Library/Application Support/SuperIsland/ai-credentials.json`
///
/// 一个提供方可以配置多个 KEY，用 `active` 指定当前生效的那个（缺省时用第一个
/// 非空 KEY）。`active` 可以写 KEY 的 `id`，也可以写 `label`：
///
/// ```json
/// {
///   "version": 1,
///   "providers": {
///     "deepseek": {
///       "active": "personal",
///       "keys": [
///         { "id": "personal", "label": "个人账号", "api_key": "sk-..." },
///         { "id": "work", "label": "公司账号", "api_key": "sk-..." }
///       ]
///     },
///     "openai": { "keys": { "default": "sk-..." } }
///   }
/// }
/// ```
///
/// 单个 KEY 的简写形式也接受：`"deepseek": "sk-..."`。
enum AIProviderCredentials {
    static let fileName = "ai-credentials.json"

    static var directoryURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("SuperIsland", isDirectory: true)
    }

    static var fileURL: URL {
        directoryURL.appendingPathComponent(fileName, isDirectory: false)
    }

    static var fileExists: Bool {
        FileManager.default.fileExists(atPath: fileURL.path)
    }

    struct ResolvedKey {
        let key: String
        let keyID: String?
        let label: String?
    }

    /// 取出某个提供方当前生效的 KEY。返回 nil 表示文件里没有可用的 KEY。
    static func resolvedKey(forProvider provider: String) -> ResolvedKey? {
        let name = normalize(provider)?.lowercased()
        guard let name, let entry = loadProviders()[name] else {
            return nil
        }

        switch entry {
        case .singleKey(let raw):
            guard let key = normalize(raw) else { return nil }
            return ResolvedKey(key: key, keyID: nil, label: nil)

        case .keyList(let active, let keys):
            let usable = keys.filter { normalize($0.apiKey) != nil }
            guard !usable.isEmpty else { return nil }

            let requested = normalize(active)
            let preferred = requested.flatMap { target in
                usable.first { normalize($0.id) == target } ?? usable.first { normalize($0.label) == target }
            }

            guard let chosen = preferred ?? usable.first, let key = normalize(chosen.apiKey) else {
                return nil
            }
            return ResolvedKey(key: key, keyID: normalize(chosen.id), label: normalize(chosen.label))
        }
    }

    private enum ProviderEntry {
        case singleKey(String)
        case keyList(active: String?, keys: [CredentialKey])
    }

    private struct CredentialKey {
        let id: String?
        let label: String?
        let apiKey: String?
    }

    private static func loadProviders() -> [String: ProviderEntry] {
        guard let data = try? Data(contentsOf: fileURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providers = root["providers"] as? [String: Any] else {
            return [:]
        }

        var result: [String: ProviderEntry] = [:]

        for (provider, rawValue) in providers {
            guard let name = normalize(provider)?.lowercased() else { continue }

            if let singleKey = rawValue as? String {
                result[name] = .singleKey(singleKey)
                continue
            }

            guard let object = rawValue as? [String: Any] else { continue }

            var keys: [CredentialKey] = []
            if let list = object["keys"] as? [[String: Any]] {
                keys = list.map { item in
                    CredentialKey(
                        id: item["id"] as? String,
                        label: item["label"] as? String,
                        apiKey: (item["api_key"] as? String) ?? (item["apiKey"] as? String)
                    )
                }
            } else if let map = object["keys"] as? [String: String] {
                // 也接受 {"keys": {"personal": "sk-..."}} 的字典写法。
                keys = map
                    .sorted { $0.key < $1.key }
                    .map { CredentialKey(id: $0.key, label: nil, apiKey: $0.value) }
            }

            result[name] = .keyList(active: object["active"] as? String, keys: keys)
        }

        return result
    }

    private static func normalize(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
