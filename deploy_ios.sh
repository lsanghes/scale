#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SIMULATOR_NAME="${1:-iPad Pro 13-inch (M4)}"
APP_ID="com.playable.intonation"
SCHEME="App"
WORKSPACE="ios/App/App.xcodeproj/project.xcworkspace"
DERIVED_DATA="$SCRIPT_DIR/ios/DerivedData"

echo "==> Syncing web assets to www/"
rm -rf www/css www/js www/index.html www/sample.musicxml
cp -r css www/css
cp -r js www/js
cp index.html www/index.html
cp sample.musicxml www/sample.musicxml

echo "==> Running cap sync"
npx cap sync ios

echo "==> Finding simulator: $SIMULATOR_NAME"
SIM_ID=$(xcrun simctl list devices available | grep "$SIMULATOR_NAME" | head -1 | grep -oE '[A-F0-9-]{36}')
if [ -z "$SIM_ID" ]; then
  echo "ERROR: No available simulator matching '$SIMULATOR_NAME'"
  echo "Available simulators:"
  xcrun simctl list devices available | grep -E "iPhone|iPad"
  exit 1
fi
echo "    Simulator ID: $SIM_ID"

echo "==> Booting simulator"
xcrun simctl boot "$SIM_ID" 2>/dev/null || true
open -a Simulator

echo "==> Building app"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$SIM_ID" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  build 2>&1 | grep -E "error:|warning:|Build succeeded|Build FAILED|Compiling|Linking|^$" || true

APP_PATH=$(find "$DERIVED_DATA" -name "*.app" -path "*/Debug-iphonesimulator/*" | head -1)
if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find built .app in $DERIVED_DATA"
  exit 1
fi

echo "==> Installing $APP_PATH"
xcrun simctl install "$SIM_ID" "$APP_PATH"

echo "==> Launching $APP_ID"
xcrun simctl launch "$SIM_ID" "$APP_ID"

echo ""
echo "Done. App launched on $SIMULATOR_NAME."
echo "Tip: pass a different simulator name as an argument, e.g.:"
echo "  ./deploy_ios.sh 'iPhone 16'"
