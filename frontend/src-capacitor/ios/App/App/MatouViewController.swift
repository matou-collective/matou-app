import UIKit
import os.log
import Capacitor

/// The app's bridge view controller (Main.storyboard points here instead of the
/// stock `CAPBridgeViewController`). It registers the two app-local plugins —
/// the iOS equivalent of `MainActivity.registerPlugin(...)` on Android — and
/// installs a router that resolves the initial document deterministically.
/// Plugins that ship as npm packages register themselves through
/// `packageClassList`; these two live in the app target, so they must be added
/// by hand here (https://capacitorjs.com/docs/ios/custom-code).
class MatouViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MatouBackendPlugin())
        bridge?.registerPluginInstance(SecureStoragePlugin())
    }

    override open func router() -> Router {
        return MatouRouter()
    }
}

/// Maps a `capacitor://localhost/...` request onto a file in the bundled
/// `public/` directory.
///
/// Capacitor's stock `CapacitorRouter` decides "is this a SPA route?" with
/// `URL(fileURLWithPath: path).pathExtension.isEmpty`. The app's very first
/// navigation is `capacitor://localhost`, whose path is the **empty string**,
/// and `URL(fileURLWithPath: "")` resolves against the process working
/// directory instead of yielding an empty path. When that directory ends in
/// `.app` — which is what the app process gets on the iOS 26 simulator — the
/// path extension comes back as `"app"`, the SPA branch is skipped, and the
/// router returns `basePath` itself. WKWebView then tries to read the `public`
/// *directory* as a file and the load fails with
/// `WebView failed provisional navigation / The file "public" couldn't be
/// opened`, leaving a white screen and no JS running at all.
///
/// So: decide on the request path only, never on the working directory. An
/// empty path, `/`, and any extension-less SPA route all serve `index.html`;
/// everything else is served as a file, exactly like the stock router.
struct MatouRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        let isDocumentRequest = trimmed.isEmpty
            || trimmed == "/"
            || (trimmed as NSString).pathExtension.isEmpty
        let resolved = isDocumentRequest ? basePath + "/index.html" : basePath + trimmed
        os_log("route %{public}@ -> %{public}@", log: OSLog(subsystem: "nz.matou.app", category: "Router"),
               type: .info, path.isEmpty ? "(empty)" : path, resolved)
        return resolved
    }
}
