# Approved V3 status-glyph comparison

Run on Apple Silicon macOS with Xcode command-line tools:

```sh
bash design/compacting-80/build.sh /tmp/kraki-status-icons-v3
```

The output contains a light/dark native comparison board, renderer assertions and
source hashes. The original baseline is read from the `mac-v0.2.62` tag; fetch
that tag if using a shallow checkout. `PreviousGlyphSource.swift` is the frozen
V2 renderer for the previous/revised comparison, not production code. The preview
is built directly from the production glyph layer, Lucide paths and colors.

The Chinese footer refers to the pre-release design review. This is an isolated
rendering harness, not an installed app, a full session-row screenshot or a live
animation capture. Generated output is not checked in.
