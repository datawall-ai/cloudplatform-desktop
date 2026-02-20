# Cloud Platform Desktop

Electron desktop app for [Cloud Platform](https://c.datawall.ai). This is a thin shell that loads the web app remotely — no bundled web content. All web updates are instant (deploy to the server, users see changes immediately). The Electron shell only needs new releases for native-level changes.

**Targets:** macOS (.dmg) + Windows (.exe)

## Quick Start

```bash
# Install dependencies
npm install

# Run in dev mode
npm start

# Build (macOS only — requires Mac)
./build.sh
```

## Build Script

`./build.sh` is a fully interactive guided script that handles everything:

1. **Version** — auto-suggests today's date as CalVer (e.g. `2026.2.20`)
2. **Git** — stages, commits, and pushes changes
3. **Build** — builds macOS DMG + Windows EXE (local or via GitHub Actions)
4. **Release** — creates GitHub Release and uploads artifacts with download URLs

Just run `./build.sh` with no arguments.

## Code Signing (macOS)

The app must be code-signed with an Apple Developer ID certificate to avoid the "damaged and can't be opened" error on Apple Silicon Macs.

### Prerequisites

- [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year)
- A **Developer ID Application** certificate

### Setup (one-time)

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

### Troubleshooting

If `security find-identity` shows **0 valid identities**:

- **Missing intermediate cert** — Run step 4 above. This is the most common issue.
- **No private key** — The CSR must be generated through Keychain Access (step 2), which creates the private key. If you generated the CSR another way, start over.
- **Cert in wrong keychain** — Both the private key and certificate must be in the **login** keychain.
- Check for the private key: `security find-key -l -t private`
- Check for the cert: `security find-certificate -c "Developer ID" -a`

## Project Structure

```
cloudplatform-desktop/
  electron/
    main.cjs          # Electron main process — loads https://c.datawall.ai
    preload.cjs        # Preload script — exposes minimal electronAPI
    offline.html       # Offline fallback page
  icons/
    logo.png           # App icon
  build.sh             # Interactive build/release script
  package.json         # Electron deps + electron-builder config
  .github/workflows/
    release.yml        # CI: builds on macOS + Windows runners
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
