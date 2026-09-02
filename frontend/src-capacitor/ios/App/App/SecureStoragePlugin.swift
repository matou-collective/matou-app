import Foundation
import Security
import os.log
import Capacitor

/// Keychain-backed key/value storage for the WebView — the iOS counterpart of
/// Electron's safeStorage-backed secureStorage IPC and Android's
/// EncryptedSharedPreferences plugin (issue #71).
///
/// Items are generic passwords under service `nz.matou.app` (account = key),
/// with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable once the
/// device has been unlocked after boot (the backend may run while the screen is
/// locked) and never synced to iCloud Keychain — these are device-bound identity
/// secrets. Nothing secret ever touches WebView localStorage. JS contract (see
/// frontend/src/lib/capacitor.ts), identical to the Java plugin:
///
///   getItem({key})        -> {value: string | null}
///   setItem({key, value}) -> void
///   removeItem({key})     -> void
@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeItem", returnType: CAPPluginReturnPromise),
    ]

    private static let log = OSLog(subsystem: "nz.matou.app", category: "SecureStorage")
    private static let service = "nz.matou.app"

    // Keychain calls do IPC to securityd; keep them off the main thread, serialized.
    private let queue = DispatchQueue(label: "nz.matou.app.securestorage", qos: .userInitiated)

    private static func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private static func describe(_ status: OSStatus) -> String {
        if let msg = SecCopyErrorMessageString(status, nil) as String? { return "\(msg) (\(status))" }
        return "OSStatus \(status)"
    }

    private func requireKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("SecureStorage: 'key' is required")
            return nil
        }
        return key
    }

    @objc func getItem(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        queue.async {
            var query = Self.baseQuery(key)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            switch status {
            case errSecSuccess:
                guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                    call.reject("SecureStorage: getItem failed: stored value is not UTF-8")
                    return
                }
                call.resolve(["value": value])
            case errSecItemNotFound:
                // Always emit a `value` field so the JS side never sees undefined.
                call.resolve(["value": NSNull()])
            default:
                os_log("getItem failed: %{public}@", log: Self.log, type: .error, Self.describe(status))
                call.reject("SecureStorage: getItem failed: \(Self.describe(status))")
            }
        }
    }

    @objc func setItem(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("SecureStorage: 'value' is required")
            return
        }
        queue.async {
            let attrs: [String: Any] = [
                kSecValueData as String: Data(value.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]
            var query = Self.baseQuery(key)
            var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
            if status == errSecItemNotFound {
                query.merge(attrs) { _, new in new }
                status = SecItemAdd(query as CFDictionary, nil)
            }
            guard status == errSecSuccess else {
                os_log("setItem failed: %{public}@", log: Self.log, type: .error, Self.describe(status))
                call.reject("SecureStorage: setItem failed: \(Self.describe(status))")
                return
            }
            call.resolve()
        }
    }

    @objc func removeItem(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        queue.async {
            let status = SecItemDelete(Self.baseQuery(key) as CFDictionary)
            // Removing a missing key succeeds, as on Android.
            guard status == errSecSuccess || status == errSecItemNotFound else {
                os_log("removeItem failed: %{public}@", log: Self.log, type: .error, Self.describe(status))
                call.reject("SecureStorage: removeItem failed: \(Self.describe(status))")
                return
            }
            call.resolve()
        }
    }
}
