# Cloud Platform Desktop

Electron desktop app for [Cloud Platform](https://c.datawall.ai). This is a thin shell that loads the web app remotely — no bundled web content. All web updates are instant (deploy to the server, users see changes immediately). The Electron shell only needs new releases for native-level changes.

**Targets:** macOS (.dmg) + Windows (.exe) + Linux (.AppImage)

## Quick Start

```bash
# Install dependencies
npm install

# Run in dev mode
npm start

# Build + release (macOS — requires Mac)
./build.sh
```

## Build Script

`./build.sh` is a fully interactive guided script that handles everything:

1. **Version** — auto-suggests today's date as CalVer (e.g. `2026.2.20`)
2. **Git** — stages, commits, and pushes changes
3. **Build** — builds macOS DMG + Windows EXE (local or via GitHub Actions)
4. **Release** — creates GitHub Release and uploads artifacts via `gh` CLI

Just run `./build.sh` with no arguments.

### Prerequisites

- **Node.js** and **npm**
- **`gh` CLI** — required for publishing releases to GitHub
  ```bash
  brew install gh
  gh auth login
  ```

## Code Signing & Notarization (macOS)

macOS apps must be **code-signed** and **notarized** to run without errors. Without this:

- **Apple Silicon (arm64):** app shows **"damaged and can't be opened"** — hard block, cannot be bypassed
- **Intel (x64):** app shows "unidentified developer" warning — can be bypassed via right-click > Open

### Why Apple Silicon is stricter

Apple Silicon enforces hardware-level W^X (Write XOR Execute) protection. All native arm64 code **must** have a valid code signature. Intel binaries (including those running under Rosetta 2) are exempt from this requirement. This is why an unsigned x64 build "works" while an unsigned arm64 build is completely blocked.

### Prerequisites

- [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year)
- A **Developer ID Application** certificate (see setup below)
- An **App-Specific Password** for notarization (see below)

### Certificate Setup (one-time)

1. Open **Keychain Access** on your Mac

2. Go to **Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority...**
   - User Email Address: your Apple ID email
   - Common Name: your name
   - Request is: **Saved to disk**
   - Click Continue and save the `.certSigningRequest` file

3. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
   - Click **+** to create a new certificate
   - Select **Developer ID Application**
   - Select **G2 Sub-CA**
   - Upload the `.certSigningRequest` file
   - Download the generated `.cer` file

4. Install the **intermediate certificate** (required for the chain to validate):
   ```bash
   curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
   ```

5. Double-click the downloaded `developerID_application.cer` to install it in the **login** keychain

6. Verify:
   ```bash
   security find-identity -v -p codesigning
   # Should show: "Developer ID Application: Your Name (TEAMID)"
   ```

electron-builder automatically detects and uses the certificate from the Keychain during builds.

### Notarization Setup (one-time)

Notarization submits your signed app to Apple for verification. It's required for downloaded apps on Apple Silicon.

1. Go to [appleid.apple.com](https://appleid.apple.com) > **Sign-In and Security** > **App-Specific Passwords**

2. Generate a new app-specific password (name it something like "electron-notarize")

3. Find your Team ID at [developer.apple.com/account](https://developer.apple.com/account) (upper right, under your name)

4. Set these environment variables before building (add to your `~/.zshrc` or `~/.bash_profile`):
   ```bash
   export APPLE_ID="your@email.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"
   ```

electron-builder uses these automatically when `"notarize": true` is set in package.json.

### Entitlements

The `electron/` directory contains two entitlements files required for Electron on Apple Silicon:

- **`entitlements.mac.plist`** — main app entitlements
- **`entitlements.mac.inherit.plist`** — helper process entitlements (Renderer, GPU, Plugin)

These grant:
- `com.apple.security.cs.allow-jit` — required for V8's JIT compiler on arm64 (W^X exception)
- `com.apple.security.cs.allow-unsigned-executable-memory` — required for V8's code generation
- `com.apple.security.cs.disable-library-validation` — allows loading Electron's bundled frameworks

Without these entitlements, the arm64 build will be signed but **will not run** — producing the "damaged" error.

### How the Build Pipeline Works

```
electron-builder --mac
  ├── Package app (x64 + arm64)
  ├── Sign .app with Developer ID certificate + entitlements
  ├── Submit .app to Apple notary service → "notarization successful"
  ├── Staple notarization ticket to .app
  ├── Create DMG (contains signed+notarized .app)
  └── Create ZIP (contains signed+notarized .app)
```

**Important:** The DMG itself is **not** signed or notarized — only the `.app` inside it. This is intentional:
- Signing the DMG and then stapling a notarization ticket to it **invalidates the DMG's code signature** (stapling modifies the file after signing)
- On arm64, an invalid signature = "damaged and can't be opened"
- The `.app` inside the DMG is already signed and notarized, which is all Gatekeeper needs

### Certificate Troubleshooting

If `security find-identity` shows **0 valid identities**:

- **Missing intermediate cert** — Run certificate setup step 4 above. This is the most common issue.
- **No private key** — The CSR must be generated through Keychain Access (step 2), which creates the private key. If you generated the CSR another way, start over.
- **Cert in wrong keychain** — Both the private key and certificate must be in the **login** keychain.
- Check for the private key: `security find-key -l -t private`
- Check for the cert: `security find-certificate -c "Developer ID" -a`

### Verifying a Build

After building, verify the `.app` signature:

```bash
# Check signature validity (should say "valid on disk")
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Cloud Platform.app"

# Check Gatekeeper acceptance (should say "accepted, source=Notarized Developer ID")
spctl --assess --type execute --verbose "release/mac-arm64/Cloud Platform.app"

# Check entitlements are embedded
codesign -d --entitlements - "release/mac-arm64/Cloud Platform.app"
```

To verify a downloaded DMG hasn't been corrupted:

```bash
# Mount the DMG
hdiutil attach "Cloud Platform-*.dmg"

# Verify the .app inside (should say "valid on disk")
codesign --verify --deep --strict --verbose=4 "/Volumes/Cloud Platform*/Cloud Platform.app"
```

If the downloaded `.app` shows `code has no resources but signature indicates they must be present`, the file was corrupted during upload/download — **not** a signing issue.

## Releasing

The build script uses `gh` CLI to create GitHub Releases and upload artifacts. This is important — using `curl --data-binary` for large file uploads (90MB+ DMGs) can corrupt binary files, especially when filenames contain spaces.

### Release Prerequisites

```bash
# Install gh CLI
brew install gh

# Authenticate
gh auth login

# Or use a token
export GITHUB_TOKEN=ghp_your_token_here
```

### Manual Release

If you need to release without the build script:

```bash
# Create release and upload all artifacts
gh release create "v2026.2.20" \
    --title "v2026.2.20" \
    --notes "Release v2026.2.20" \
    release/*.dmg release/*.zip release/*.exe
```

## Project Structure

```
cloudplatform-desktop/
  electron/
    main.cjs                        # Electron main process — loads https://c.datawall.ai
    preload.cjs                     # Preload script — exposes minimal electronAPI
    offline.html                    # Offline fallback page
    entitlements.mac.plist          # macOS entitlements (main app)
    entitlements.mac.inherit.plist  # macOS entitlements (helper processes)
  icons/
    logo.png                        # App icon
  build.sh                          # Interactive build/release script
  package.json                      # Electron deps + electron-builder config
  .github/workflows/
    release.yml                     # CI: builds on macOS + Windows runners
```

## Versioning

Uses **CalVer** (calendar versioning) with semver-compatible format: `YYYY.M.D` (e.g. `2026.2.20`). Same-day rebuilds auto-increment: `2026.2.20-2`, `2026.2.20-3`, etc.

## GitHub Actions

Pushing a `v*` tag triggers CI builds on macOS and Windows runners, which upload artifacts to a GitHub Release. The build script can do this for you (option 2 in the build step).

## Architecture

- **Remote loading** — the Electron window loads `https://c.datawall.ai` directly
- **Offline fallback** — if the server is unreachable, shows a retry page
- **External links** — open in the system browser, not inside Electron
- **Multi-arch** — macOS builds both x64 and arm64; Windows builds both x64 and arm64
