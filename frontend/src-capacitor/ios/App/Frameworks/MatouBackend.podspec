# Local pod that links the gomobile-built embedded backend into the App target.
# Matou.xcframework next to this file is git-ignored and produced by
# `make -C backend build-ios-xcframework` (scripts/ios/build-ipa.sh does it for
# you). Going through a pod means project.pbxproj never needs hand-editing to
# link the framework: `pod install` (run by `npx cap sync ios`) wires it up.
Pod::Spec.new do |s|
  s.name                  = 'MatouBackend'
  s.version               = '0.0.1'
  s.summary               = 'Embedded Matou Go backend (gomobile xcframework)'
  s.homepage              = 'https://git.matou.nz/Matou/matou-app'
  s.license               = { :type => 'AGPL-3.0', :file => '../../../../../LICENSE' }
  s.author                = 'Matou'
  s.source                = { :path => '.' }
  s.platform              = :ios, '15.0'
  s.vendored_frameworks   = 'Matou.xcframework'
  # Go's net package on Darwin resolves through libresolv (res_search);
  # without this the final link fails with undefined _res_9_* symbols.
  s.libraries             = 'resolv'
end
