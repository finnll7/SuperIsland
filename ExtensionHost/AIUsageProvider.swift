import Foundation
#if os(macOS)
import Security
import LocalAuthentication
#endif

enum AIUsageProvider {
    private static let cacheTTL: TimeInterval = 300

    // MARK: - DeepSeek
    //
    // DeepSeek 只有余额接口（金额），没有配额百分比。凭据按
    // 「本地配置文件 → 环境变量 → 钥匙串」的顺序查找，
    // 配置文件见 AIProviderCredentials。
    private static let deepseekBalanceURL = "https://api.deepseek.com/user/balance"
    private static let deepseekKeychainServices = ["DeepSeek API Key", "deepseek"]
    private static let deepseekKeyJSONKeys: Set<String> = ["api_key", "apiKey", "key", "token"]
    private static var cachedSnapshot: [String: Any]?
    private static var cachedAt: Date?
    private static let cacheLock = NSLock()
    private static var isRefreshing = false

    // Returns cached data immediately (never blocks). Triggers a background
    // refresh if the cache is missing or stale. This prevents the semaphore-
    // blocked network calls in fetchJSON from freezing the main thread.
    static func snapshot() -> [String: Any] {
        let nowDate = Date()

        cacheLock.lock()
        let existing = cachedSnapshot
        let age = cachedAt.map { nowDate.timeIntervalSince($0) } ?? cacheTTL
        cacheLock.unlock()

        if existing == nil || age >= cacheTTL {
            triggerBackgroundRefresh()
        }

        return existing ?? [
            "updatedAt": Int(nowDate.timeIntervalSince1970),
            "credentialsPath": AIProviderCredentials.fileURL.path,
            "deepseek": ["available": false, "source": "loading"] as [String: Any]
        ]
    }

    private static func triggerBackgroundRefresh() {
        cacheLock.lock()
        guard !isRefreshing else {
            cacheLock.unlock()
            return
        }
        isRefreshing = true
        cacheLock.unlock()

        DispatchQueue.global(qos: .utility).async {
            let nowDate = Date()
            let now = Int(nowDate.timeIntervalSince1970)
            let payload: [String: Any] = [
                "updatedAt": now,
                "credentialsPath": AIProviderCredentials.fileURL.path,
                "deepseek": buildDeepSeekPayload(updatedAt: now)
            ]

            cacheLock.lock()
            cachedAt = nowDate
            cachedSnapshot = payload
            isRefreshing = false
            cacheLock.unlock()
        }
    }

    // MARK: - DeepSeek

    private static func buildDeepSeekPayload(updatedAt: Int) -> [String: Any] {
        guard let credential = loadDeepSeekCredential() else {
            return deepSeekFailurePayload(
                updatedAt: updatedAt,
                source: "unavailable",
                error: "未配置 API Key · 见 \(AIProviderCredentials.fileName)"
            )
        }

        guard let url = URL(string: deepseekBalanceURL) else {
            return deepSeekFailurePayload(updatedAt: updatedAt, source: credential.source, error: "接口地址无效")
        }

        let result = fetchJSONResult(url: url, bearerToken: credential.key, timeout: 4.0)

        if result.status == 0 {
            return deepSeekFailurePayload(updatedAt: updatedAt, source: credential.source, error: "请求失败")
        }

        guard (200..<300).contains(result.status) else {
            let message: String
            switch result.status {
            case 401, 403: message = "API Key 无效或无权限"
            case 429: message = "请求过于频繁"
            default: message = "HTTP \(result.status)"
            }
            return deepSeekFailurePayload(updatedAt: updatedAt, source: credential.source, error: message)
        }

        guard let response = result.object else {
            return deepSeekFailurePayload(updatedAt: updatedAt, source: credential.source, error: "响应解析失败")
        }

        let infos = (response["balance_infos"] as? [[String: Any]]) ?? []
        let info = infos.first { ($0["currency"] as? String) == "CNY" } ?? infos.first

        guard let info, let totalBalance = asDoubleOrNil(info["total_balance"]) else {
            return deepSeekFailurePayload(updatedAt: updatedAt, source: credential.source, error: "返回数据中没有余额")
        }

        var payload: [String: Any] = [
            "available": true,
            "source": credential.source,
            "sufficient": response["is_available"] as? Bool ?? true,
            "currency": info["currency"] as? String ?? "CNY",
            "totalBalance": totalBalance,
            "error": NSNull(),
            "updatedAt": updatedAt
        ]
        payload["grantedBalance"] = asDoubleOrNil(info["granted_balance"]) ?? NSNull()
        payload["toppedUpBalance"] = asDoubleOrNil(info["topped_up_balance"]) ?? NSNull()
        return payload
    }

    private static func deepSeekFailurePayload(updatedAt: Int, source: String, error: String) -> [String: Any] {
        [
            "available": false,
            "source": source,
            "sufficient": NSNull(),
            "currency": NSNull(),
            "totalBalance": NSNull(),
            "grantedBalance": NSNull(),
            "toppedUpBalance": NSNull(),
            "error": error,
            "updatedAt": updatedAt
        ]
    }

    /// 凭据查找顺序：本地配置文件 → 环境变量 → 钥匙串。
    /// 配置文件是常规来源（支持同一提供方配置多个 KEY）；
    /// 环境变量与钥匙串只作为临时覆盖/不留明文时的兜底。
    private static func loadDeepSeekCredential() -> (key: String, source: String)? {
        if let resolved = AIProviderCredentials.resolvedKey(forProvider: "deepseek") {
            return (key: resolved.key, source: "config")
        }

        if let key = normalizedDeepSeekKey(ProcessInfo.processInfo.environment["DEEPSEEK_API_KEY"]) {
            return (key: key, source: "environment")
        }

        #if os(macOS)
        // 只静默读取：配置文件已经是常规来源，钥匙串作为兜底不能弹出系统授权框
        // （弹窗会阻塞整个用量刷新）。条目需要以 -A 创建才允许应用静默读取。
        if let key = loadDeepSeekKeyFromKeychain() {
            return (key: key, source: "keychain")
        }
        #endif

        return nil
    }

    private static func normalizedDeepSeekKey(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    #if os(macOS)
    /// 静默读取钥匙串里的 DeepSeek KEY（纯文本，或含 api_key 字段的 JSON）。
    /// 使用 interactionNotAllowed 的 LAContext，因此不会弹出系统授权框。
    private static func loadDeepSeekKeyFromKeychain() -> String? {
        let context = LAContext()
        context.interactionNotAllowed = true
        context.localizedReason = "Access DeepSeek API key for balance status."

        for service in deepseekKeychainServices {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne
            ]
            query[kSecUseAuthenticationContext as String] = context

            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data else {
                continue
            }

            if let object = try? JSONSerialization.jsonObject(with: data),
               let key = findStringValue(in: object, keys: deepseekKeyJSONKeys, depth: 0, maxDepth: 4),
               let normalized = normalizedDeepSeekKey(key) {
                return normalized
            }

            if let text = String(data: data, encoding: .utf8),
               !text.hasPrefix("{"),
               let normalized = normalizedDeepSeekKey(text) {
                return normalized
            }
        }

        return nil
    }
    #endif

    private static func findStringValue(
        in object: Any,
        keys: Set<String>,
        depth: Int,
        maxDepth: Int
    ) -> String? {
        if depth > maxDepth {
            return nil
        }

        if let dictionary = object as? [String: Any] {
            for key in keys {
                if let value = dictionary[key] as? String, !value.isEmpty {
                    return value
                }
            }

            for value in dictionary.values {
                if let nested = findStringValue(
                    in: value,
                    keys: keys,
                    depth: depth + 1,
                    maxDepth: maxDepth
                ) {
                    return nested
                }
            }
            return nil
        }

        if let array = object as? [Any] {
            for value in array {
                if let nested = findStringValue(
                    in: value,
                    keys: keys,
                    depth: depth + 1,
                    maxDepth: maxDepth
                ) {
                    return nested
                }
            }
        }

        return nil
    }

    // MARK: - Shared

    /// 与 fetchJSON 相同，但额外返回 HTTP 状态码，便于区分「Key 无效」「限流」
    /// 和「网络不可达」。status == 0 表示请求根本没拿到响应。
    private static func fetchJSONResult(
        url: URL,
        bearerToken: String,
        timeout: TimeInterval
    ) -> (status: Int, object: [String: Any]?) {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("SuperIsland/1.0", forHTTPHeaderField: "User-Agent")

        let semaphore = DispatchSemaphore(value: 0)
        var status = 0
        var parsed: [String: Any]?

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }

            guard error == nil, let http = response as? HTTPURLResponse else {
                return
            }
            status = http.statusCode
            guard (200..<300).contains(http.statusCode),
                  let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }
            parsed = object
        }

        task.resume()
        _ = semaphore.wait(timeout: .now() + timeout + 0.3)
        return (status: status, object: parsed)
    }

    private static func asDoubleOrNil(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let parsed = Double(value) { return parsed }
        return nil
    }

}
