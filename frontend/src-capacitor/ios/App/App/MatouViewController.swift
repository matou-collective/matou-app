import UIKit
import Capacitor

/// The app's bridge view controller (Main.storyboard points here instead of the
/// stock `CAPBridgeViewController`). Its only job is registering the two
/// app-local plugins — the iOS equivalent of `MainActivity.registerPlugin(...)`
/// on Android. Plugins that ship as npm packages register themselves through
/// `packageClassList`; these two live in the app target, so they must be added
/// by hand here (https://capacitorjs.com/docs/ios/custom-code).
class MatouViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MatouBackendPlugin())
        bridge?.registerPluginInstance(SecureStoragePlugin())
    }
}
