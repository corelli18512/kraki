# Kraki for Windows 0.1.4

Windows 10/11 x64 preview, including Kraki CLI 0.38.10.

- About now shows the GitHub Run ID, exact source commit and build provenance links.
- The installer and bundled background service are built together on GitHub Actions from the same commit.
- The final installer comes with a signed GitHub provenance bundle, checksums and a release manifest; publication verifies the proof and downloaded assets.

This preview installer is still not Authenticode-signed. Windows may display SmartScreen warnings. GitHub build provenance is a separate verification mechanism and does not remove those warnings.

[How to verify the installer](https://github.com/corelli18512/kraki/blob/win-v0.1.4/docs/BUILD_PROVENANCE.md).
