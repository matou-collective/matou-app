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
                    var boundPort: Int = 0
                    // MobileStart is a C function (not an ObjC method), so Swift does
                    // not bridge its trailing NSError** into `throws`; check by hand.
                    var startError: NSError?
                    guard MobileStart(dataDir.path, configServerUrl, freshToken, &boundPort, &startError) else {
                        throw startError ?? NSError(domain: "go", code: 1,
                                                    userInfo: [NSLocalizedDescriptionKey: "MobileStart returned false without an error"])
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
}
