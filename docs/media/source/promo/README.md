# Promo video source

1. `python3 build-mascot.py` regenerates the mascot dot data inside `promo.html` from `src/assets/peacock-icon.png` (needs Pillow).
2. Set `PLAYWRIGHT_CORE` (playwright-core path), `CHROME` (Chromium executable) and `FFMPEG`, then run `node render.mjs`.
3. It writes `docs/media/peacock-promo.mp4` and `docs/media/peacock-promo.gif`. `--stills 3,12.5` dumps single frames, `--frames <dir>` sets the scratch folder, `--out <dir>` the output folder.

The window in each scene is drawn in HTML, not recorded: it follows the app's look (orange accent, the labels on its buttons) without being the app. The wordmark is set in Unbounded, bundled as `src/assets/unbounded-800.woff2`.
