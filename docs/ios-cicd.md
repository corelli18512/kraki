# iOS CI and TestFlight delivery

Kraki has two independent GitHub Actions paths for iOS.

## Pull-request and main-branch CI

`.github/workflows/ci.yml` runs the `Test iOS (Kraki)` job on `macos-26`.
It builds the native app and its notification service extension and runs the
`KrakiTests` suite on an available iPhone Simulator. No Apple credentials or
code-signing secrets are used.

The job uploads its `.xcresult` bundle even when tests fail. Once the workflow
has run successfully on the default branch, make `Test iOS (Kraki)` a required
branch-protection check for `main`.

## TestFlight CD

`.github/workflows/ios-testflight.yml` archives, exports and uploads the iOS app
to App Store Connect. It can be triggered in either of two ways:

- Run **iOS TestFlight** manually and enter a semantic version such as `0.1.1`.
- Push a tag such as `ios-v0.1.1`.

The GitHub Actions run number is used as `CFBundleVersion`, so every upload from
the repository has a monotonically increasing build number. The selected
version and build number are applied to both the main app and
`KrakiNotification` extension at archive time.

The release job uses automatic provisioning through `xcodebuild` and an App
Store Connect API key. A locally exported Apple Distribution certificate gives
the runner the signing private key; Xcode downloads or creates the matching App
Store provisioning profiles for these bundle identifiers:

- `chat.kraki.ios`
- `chat.kraki.ios.notification`

Both identifiers must belong to Apple Developer team `3A83X5JZ3S` and retain
the App Groups, Keychain Sharing, Associated Domains and Push Notifications
capabilities declared by the checked-in entitlements.

## GitHub environment and secrets

Create a protected GitHub environment named `ios-release`. Requiring a reviewer
is recommended because a successful job uploads a build to TestFlight.

Configure these environment secrets:

| Secret | Content |
| --- | --- |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect issuer UUID |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | Base64 of `AuthKey_<KEY_ID>.p8` |
| `IOS_DISTRIBUTION_CERTIFICATE_BASE64` | Base64 of an exported Apple Distribution `.p12` |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |

Encode files without line wrapping on macOS:

```bash
base64 -i AuthKey_KEYID.p8 | pbcopy
base64 -i Kraki-Apple-Distribution.p12 | pbcopy
```

The workflow writes the API key into the standard
`~/.appstoreconnect/private_keys` location and creates an ephemeral keychain for
the distribution certificate. Secrets and private keys are never committed.

## First release checklist

1. Ensure the Kraki app record exists in App Store Connect for bundle ID
   `chat.kraki.ios`.
2. Confirm the notification extension identifier exists in Certificates,
   Identifiers & Profiles.
3. Create an Apple Distribution certificate for team `3A83X5JZ3S`, import it
   into the login keychain and export it with its private key as a password-
   protected `.p12`.
4. Create an App Store Connect API key with App Manager access and access to the
   Kraki app.
5. Add the five secrets to the protected `ios-release` environment.
6. Run the workflow manually with the intended marketing version.
7. After App Store Connect finishes processing, add the build to an internal
   TestFlight group. Automatic external distribution is intentionally not part
   of this workflow.

## Local unsigned verification

```bash
cd packages/arm/ios
xcodebuild \
  -project Kraki.xcodeproj \
  -scheme Kraki \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=latest' \
  CODE_SIGNING_ALLOWED=NO \
  test
```
