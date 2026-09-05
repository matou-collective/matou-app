import Foundation
import Security
import os.log
import Capacitor
import Matou

/// Boots the embedded Go backend (gomobile `Matou.xcframework`, see
/// `backend/cmd/mobile`) and hands the WebView what it needs to talk to it.
/// `getInfo()` returns `{port, token}` — the same contract the Electron preload
/// exposes via the get-backend-port / get-api-token IPC handlers and the
/// Android `MatouBackendPlugin.java`, so `frontend/src/lib/capacitor.ts` works
/// unchanged on iOS.
///
/// The backend listens on 127.0.0.1 only; the per-launch 32-byte token is what
/// TokenGuard requires on mutating requests. `configServerUrl` comes from the
/// plugin config in capacitor.config.json, baked from VITE_PROD_CONFIG_URL by
/// scripts/ios/build-ipa.sh (exactly as build-apk.sh / build-aab.sh do for Android).
@objc(MatouBackendPlugin)
public class MatouBackendPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MatouBackendPlugin"
    public let jsName = "MatouBackend"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
    ]

    private static let log = OSLog(subsystem: "nz.matou.app", category: "MatouBackend")

    // MobileStart blocks while the backend boots (it fetches config over the
    // network), so it must run off the main thread. One serial queue also
    // serializes concurrent getInfo() calls from the WebView.
    private let queue = DispatchQueue(label: "nz.matou.app.backend", qos: .userInitiated)

    // Start once per process; MobileStart is idempotent on the Go side, but the
    // token must stay stable across getInfo() calls so every caller can auth.
    // Only touched on `queue`.
    private var port: Int = 0
    private var token: String?

    @objc func getInfo(_ call: CAPPluginCall) {
        let configServerUrl = getConfig().getString("configServerUrl") ?? ""
        guard !configServerUrl.isEmpty else {
            call.reject("MatouBackend: configServerUrl missing from capacitor.config.json plugins config — run scripts/ios/build-ipa.sh")
            return
        }

        queue.async {
            do {
                if self.token == nil {
                    let freshToken = try Self.randomToken()
                    let dataDir = try Self.dataDirectory()
                    // Per-install at-rest encryption key for {dataDir}/identity.json
                    // (issue #117). Generated once and held in the Keychain, read
                    // back verbatim on every later launch. Empty selects the
                    // backend's legacy plaintext path when the Keychain is
                    // unavailable, so the app still boots. Never logged.
                    let identityKey = Self.identityEncryptionKey()
                    var boundPort: Int = 0
                    // MobileStartWithEncryptionKey is a C function (not an ObjC method),
                    // so Swift does not bridge its trailing NSError** into `throws`;
                    // check by hand. (gomobile exports StartWithEncryptionKey as
                    // MobileStartWithEncryptionKey — see backend/cmd/mobile/mobile.go.)
                    var startError: NSError?
                    guard MobileStartWithEncryptionKey(dataDir.path, configServerUrl, freshToken, identityKey, &boundPort, &startError) else {
                        throw startError ?? NSError(domain: "go", code: 1,
                                                    userInfo: [NSLocalizedDescriptionKey: "MobileStartWithEncryptionKey returned false without an error"])
                    }
                    self.port = boundPort
                    self.token = freshToken
                    // .default, not .info: info-level messages are not persisted to the
                    // log store, so `log show` (and the CI smoke check) never sees them.
                    os_log("backend up on 127.0.0.1:%d", log: Self.log, type: .default, boundPort)
                }
                call.resolve(["port": self.port, "token": self.token ?? ""])
            } catch {
                os_log("backend start failed: %{public}@", log: Self.log, type: .error, error.localizedDescription)
                call.reject("MatouBackend: backend start failed: \(error.localizedDescription)", nil, error)
            }
        }
    }

    /// `<Application Support>/matou` — the iOS counterpart of Android's
    /// `getFilesDir()/matou`. Holds key material and any-sync state, so it is
    /// excluded from iCloud/iTunes backup (device-bound identity, same posture
    /// as the Android Keystore-held secrets).
    private static func dataDirectory() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var dir = base.appendingPathComponent("matou", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return dir
    }

    /// 32 random bytes, hex-encoded — mirrors the Electron launcher's and the
    /// Android plugin's per-launch API token.
    private static func randomToken() throws -> String {
        var raw = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, raw.count, &raw)
        guard status == errSecSuccess else {
            throw NSError(domain: "nz.matou.app", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "SecRandomCopyBytes failed (\(status))"])
        }
        return raw.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Identity encryption key (issue #117)

    /// Keychain service + account the per-install identity-encryption key lives
    /// under. Same service and accessibility posture as SecureStoragePlugin
    /// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — device-bound, never
    /// synced to iCloud), so the key shares the identity trust root.
    private static let keychainService = "nz.matou.app"
    private static let identityKeyAccount = "backend_identity_key"

    /// The at-rest identity-encryption key passed to StartWithEncryptionKey.
    /// Read from the Keychain; generated once (32 random bytes, hex-encoded) and
    /// stored on first launch. Returns "" — the backend's legacy plaintext path —
    /// whenever the Keychain is unavailable, so the app still boots. The key is
    /// never logged.
    private static func identityEncryptionKey() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: identityKeyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else {
                os_log("identity key: stored value unreadable — using legacy plaintext identity", log: log, type: .default)
                return ""
            }
            return key
        case errSecItemNotFound:
            return generateAndStoreIdentityKey()
        default:
            // A genuine Keychain fault (e.g. device not unlocked since boot). Do
            // NOT mint a fresh key — that would orphan an already-encrypted
            // identity.json. Fall back to the legacy plaintext path this launch.
            os_log("identity key: Keychain read failed (%{public}@) — using legacy plaintext identity",
                   log: log, type: .default, describe(status))
            return ""
        }
    }

    /// Generate the identity key once and persist it under the Keychain. Returns
    /// "" (legacy plaintext path) if generation or the Keychain write fails.
    private static func generateAndStoreIdentityKey() -> String {
        let key: String
        do {
            key = try randomToken()
        } catch {
            os_log("identity key: generation failed (%{public}@) — using legacy plaintext identity",
                   log: log, type: .default, error.localizedDescription)
            return ""
        }
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: identityKeyAccount,
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            os_log("identity key: Keychain store failed (%{public}@) — using legacy plaintext identity",
                   log: log, type: .default, describe(status))
            return ""
        }
        return key
    }

    private static func describe(_ status: OSStatus) -> String {
        if let msg = SecCopyErrorMessageString(status, nil) as String? { return "\(msg) (\(status))" }
        return "OSStatus \(status)"
    }
}
