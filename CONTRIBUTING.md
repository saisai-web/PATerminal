# Contributing to PATerminal

Thank you for helping improve PATerminal.

## Before you start

- Use GitHub Issues for reproducible bugs and narrowly scoped feature proposals.
- Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.
- Search existing Issues and pull requests before opening a duplicate.
- Keep reports free of terminal history, credentials, license keys, private source, and personal data.

Opening an Issue does not guarantee implementation. Larger design changes should be discussed before substantial work begins.

## Pull requests

1. Create a focused branch and keep unrelated changes out of the pull request.
2. Follow the module boundaries in [pa-terminal/src/ARCHITECTURE.md](pa-terminal/src/ARCHITECTURE.md).
3. Add or update tests for behavior changes.
4. Run the relevant checks from the repository root:

   ```sh
   cd pa-terminal
   npm ci
   npm run check:architecture
   npm run check:eula
   npm run check:third-party-notices
   npx tsc --noEmit
   npm run test:ui:smoke
   (cd src-tauri && cargo test)
   ```

5. Explain the user-visible outcome, verification performed, and any platform-specific behavior that still needs manual testing.

Keyboard input and native WebView behavior can differ from Chromium automation. Changes to terminal input, signing, platform integration, or installers may require release-build testing on the affected operating system.

## Contributor terms

By submitting a contribution, you confirm that you have the right to submit it and that your contribution may be used, modified, and distributed as part of PATerminal under the project's then-current licensing terms. You retain ownership of your contribution. A separate contributor agreement may be required before acceptance of substantial contributions.

The repository is source-available, not open source. Viewing or forking the repository and contributing code does not grant redistribution, commercial-use, sublicensing, or hosting rights beyond the [EULA](LICENSE.md).

## Personal source builds

The EULA permits limited personal, non-commercial source builds. Such builds are unofficial and are not promised signing, notarization, update service, compatibility, support, or security maintenance. Do not present a self-built or modified copy as an official PATerminal release.
