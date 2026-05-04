#!/bin/bash
# Build script for cloudplatform-desktop
#
# Usage:
#   ./build.sh    # Fully interactive — guides you through everything
#
# For GitHub releases, set GITHUB_TOKEN:
#   export GITHUB_TOKEN=ghp_your_token_here

set -e

# Colors (use $'...' so they're real escape sequences, not literal strings)
GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
NC=$'\033[0m'

# GitHub config
GITHUB_OWNER="datawall-ai"
GITHUB_REPO="cloudplatform-desktop"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"  # Set via: export GITHUB_TOKEN=ghp_your_token_here

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# ============================================
# Helpers
# ============================================

detect_os() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "mac" ;;
        MINGW*|MSYS*|CYGWIN*) echo "win" ;;
        *)       echo "unknown" ;;
    esac
}

HOST_OS=$(detect_os)
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

# Build the Windows installers (x64 + arm64 NSIS) inside the official
# electronuserland/builder:wine image. Cross-compiling NSIS from macOS
# directly is fragile (Wine + electron-builder version drift); Docker
# pins everything and produces deterministic artifacts. node_modules
# and the electron caches live in named volumes so re-runs are fast
# and don't clobber the host's macOS-built node_modules.
build_windows_in_docker() {
    if ! command -v docker &>/dev/null; then
        echo "  ${RED}Docker is required for Windows cross-builds.${NC}"
        echo "  Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/"
        return 1
    fi
    if ! docker info &>/dev/null; then
        echo "  ${RED}Docker is installed but not running. Start Docker Desktop first.${NC}"
        return 1
    fi

    local IMAGE="electronuserland/builder:wine"
    local NAME_PREFIX="cloudplatform-desktop"

    if ! docker image inspect "$IMAGE" &>/dev/null; then
        echo "  ${GREEN}==> Pulling $IMAGE (one-time, ~1.5GB)...${NC}"
        docker pull "$IMAGE"
    fi

    echo "  ${GREEN}==> Building Windows (x64 + arm64) inside $IMAGE...${NC}"
    docker run --rm \
        --env ELECTRON_CACHE="/root/.cache/electron" \
        --env ELECTRON_BUILDER_CACHE="/root/.cache/electron-builder" \
        -v "$SCRIPT_DIR:/project" \
        -v "${NAME_PREFIX}-node-modules:/project/node_modules" \
        -v "${NAME_PREFIX}-electron-cache:/root/.cache/electron" \
        -v "${NAME_PREFIX}-electron-builder-cache:/root/.cache/electron-builder" \
        -w /project \
        "$IMAGE" \
        /bin/bash -lc "set -e; npm install --no-audit --no-fund --prefer-offline; npx electron-builder --win"
}

# ============================================
# Header
# ============================================

echo ""
echo "${CYAN}============================================${NC}"
echo "${CYAN}  Cloud Platform Desktop${NC}"
echo "${CYAN}  Current version: $CURRENT_VERSION${NC}"
echo "${CYAN}  Host: $HOST_OS ($(uname -m))${NC}"
echo "${CYAN}============================================${NC}"
echo ""

# ============================================
# Step 1: Version (UTC timestamp — YYMMDD.HHMM.<bump>)
# ============================================
#
# Every build gets a fresh version string derived from the UTC clock so
# the version is monotonically increasing and never matches a prior
# build. Format: YYMMDD.HHMM.0 (semver-compatible 3-part). On the rare
# case where two builds happen in the same UTC minute, the trailing
# segment bumps until we find a free tag.
#
# Examples:
#   2026-05-03 11:51 UTC  →  260503.1151.0
#   same minute rebuild   →  260503.1151.1

YYMMDD=$(date -u +%y%m%d)
HHMM=$(date -u +%H%M)
SUGGESTED="${YYMMDD}.${HHMM}.0"
BUMP=0
while git tag -l "v$SUGGESTED" | grep -q .; do
    BUMP=$((BUMP + 1))
    SUGGESTED="${YYMMDD}.${HHMM}.${BUMP}"
done

echo "${BOLD}Step 1: Version${NC}"
echo ""
echo "  Current version: ${GREEN}$CURRENT_VERSION${NC}"
echo "  Suggested:       ${CYAN}$SUGGESTED${NC}"
echo ""
read -p "  Version (Enter for $SUGGESTED): " NEW_VERSION
VERSION="${NEW_VERSION:-$SUGGESTED}"

if [ "$VERSION" != "$CURRENT_VERSION" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
    else
        sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
    fi

    echo "  ${GREEN}==> Updated to $VERSION${NC}"
else
    echo "  Keeping $VERSION"
fi

# ============================================
# Step 2: Git
# ============================================

echo ""
echo "${BOLD}Step 2: Git${NC}"
echo ""

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "  No changes to commit."
else
    git status --short | sed 's/^/  /'
    echo ""
    read -p "  Commit message (Enter for \"v$VERSION\"): " COMMIT_MSG
    COMMIT_MSG="${COMMIT_MSG:-v$VERSION}"

    git add -A
    git commit -m "$COMMIT_MSG"
    echo "  ${GREEN}==> Committed: $COMMIT_MSG${NC}"
fi

echo "  ${GREEN}==> Pushing to origin...${NC}"
git push origin "$(git branch --show-current)"
echo "  Pushed."

# ============================================
# Step 3: Build
# ============================================

echo ""
echo "${BOLD}Step 3: Build${NC}"
echo ""

if [ "$HOST_OS" = "mac" ]; then
    echo "  1) ${GREEN}Build on this machine${NC} → .dmg + .zip + .exe"
    echo "  2) ${CYAN}Push to GitHub Actions${NC} → CI builds on macOS + Windows runners"
    echo "  3) ${YELLOW}Skip${NC} → just push code, no build"
    echo ""
    read -p "  Choose [1/2/3]: " BUILD_CHOICE
else
    echo "  ${YELLOW}You're on $HOST_OS — local builds require macOS.${NC}"
    echo ""
    echo "  1) ${CYAN}Push to GitHub Actions${NC} → CI builds on macOS + Windows runners"
    echo "  2) ${YELLOW}Skip${NC} → just push code, no build"
    echo ""
    read -p "  Choose [1/2]: " NON_MAC_CHOICE

    # Map non-mac choices to the same case values
    case "$NON_MAC_CHOICE" in
        1) BUILD_CHOICE="2" ;;
        2) BUILD_CHOICE="3" ;;
        *) BUILD_CHOICE="$NON_MAC_CHOICE" ;;
    esac
fi

case "$BUILD_CHOICE" in

# ============================================
# Build locally (Mac only)
# ============================================
1)
    # Install deps if needed
    if [ ! -d "node_modules" ]; then
        echo "  ${GREEN}==> Installing dependencies...${NC}"
        if [ -f "package-lock.json" ]; then
            npm ci
        else
            npm install
        fi
    fi

    echo "  ${GREEN}==> Cleaning previous build...${NC}"
    rm -rf release/ 2>/dev/null || true

    echo "  ${GREEN}==> Building macOS (x64 + arm64)...${NC}"
    npx electron-builder --mac

    # electron-builder signs the .app, notarizes it, then packages it into the DMG.
    # The .app inside the DMG is signed + notarized — that's all Gatekeeper needs.
    # Do NOT sign/notarize the DMG itself — stapling invalidates the DMG's codesign,
    # which causes "damaged and can't be opened" on Apple Silicon (arm64 requires
    # valid signatures; x64 tolerates invalid ones with a weaker warning).

    # Verify .app signatures
    for APP_DIR in release/mac release/mac-arm64; do
        [ -d "$APP_DIR" ] || continue
        APP_PATH="$APP_DIR/Cloud Platform.app"
        [ -d "$APP_PATH" ] || continue
        echo "  Verifying $(basename "$APP_DIR")/Cloud Platform.app..."
        codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | sed 's/^/    /'
        spctl --assess --type execute --verbose "$APP_PATH" 2>&1 | sed 's/^/    /'
    done

    echo "  ${GREEN}==> Building Windows (x64 + arm64) via Docker...${NC}"
    if ! build_windows_in_docker; then
        echo "  ${YELLOW}Skipping Windows artifacts.${NC} Mac builds above are still valid."
    fi

    echo ""
    echo "  ${GREEN}==> Build complete:${NC}"
    echo ""
    ls -lh release/*.dmg release/*.zip release/*.exe 2>/dev/null | sed 's/^/  /' || echo "  (no artifacts)"

    # ============================================
    # Step 4: Release
    # ============================================

    echo ""
    echo "${BOLD}Step 4: Publish to GitHub Releases?${NC}"
    echo ""
    echo "  This uploads the built files so users can download them."
    echo ""
    read -p "  Publish v$VERSION? [y/N]: " PUBLISH_CHOICE

    if [[ "$PUBLISH_CHOICE" =~ ^[Yy]$ ]]; then

        # Require gh CLI for reliable uploads (curl --data-binary corrupts large files)
        if ! command -v gh &>/dev/null; then
            echo ""
            echo "  ${RED}gh CLI is required for publishing releases.${NC}"
            echo ""
            echo "  Install it:"
            echo "    brew install gh"
            echo "    gh auth login"
            echo ""
            echo "  Artifacts are in release/"
            exit 1
        fi

        echo "  ${GREEN}==> Creating release v$VERSION and uploading artifacts...${NC}"

        # Collect artifact files
        ARTIFACTS=()
        for FILE in release/*.dmg release/*.zip release/*.exe; do
            [ -f "$FILE" ] && ARTIFACTS+=("$FILE")
        done

        if [ ${#ARTIFACTS[@]} -eq 0 ]; then
            echo "  ${RED}No artifacts found to upload.${NC}"
            exit 1
        fi

        echo "  Files to upload:"
        for FILE in "${ARTIFACTS[@]}"; do
            SIZE=$(ls -lh "$FILE" | awk '{print $5}')
            echo "    $(basename "$FILE") ($SIZE)"
        done
        echo ""

        # Create release and upload in one command
        gh release create "v$VERSION" \
            --repo "$GITHUB_OWNER/$GITHUB_REPO" \
            --title "v$VERSION" \
            --notes "Release v$VERSION" \
            "${ARTIFACTS[@]}"

        RELEASE_URL="https://github.com/$GITHUB_OWNER/$GITHUB_REPO/releases/download/v$VERSION"

        echo ""
        echo "  ${GREEN}==> Release published!${NC}"
        echo ""
        echo "  ${BOLD}Download URLs:${NC}"
        for FILE in "${ARTIFACTS[@]}"; do
            FILENAME=$(basename "$FILE")
            ENCODED="${FILENAME// /%20}"
            echo "  ${CYAN}$RELEASE_URL/$ENCODED${NC}"
        done
        echo ""
        echo "  ${BOLD}Release page:${NC}"
        echo "  https://github.com/$GITHUB_OWNER/$GITHUB_REPO/releases/tag/v$VERSION"
    else
        echo "  Skipped. Artifacts are in release/"
    fi
    ;;

# ============================================
# Push tag → GitHub Actions builds
# ============================================
2)
    echo ""
    echo "  ${GREEN}==> Tagging v$VERSION and pushing...${NC}"

    git tag -f "v$VERSION"
    git push origin "v$VERSION" --force

    echo ""
    echo "  ${GREEN}==> CI triggered!${NC}"
    echo "  Watch: https://github.com/$GITHUB_OWNER/$GITHUB_REPO/actions"
    echo "  Release: https://github.com/$GITHUB_OWNER/$GITHUB_REPO/releases/tag/v$VERSION"
    ;;

# ============================================
# Skip
# ============================================
3)
    echo ""
    echo "  Code pushed. No build."
    ;;

*)
    echo "  ${RED}Invalid choice.${NC}"
    exit 1
    ;;
esac

echo ""
echo "${GREEN}==>${NC} Done."
