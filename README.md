# ECHO-H browser demo

Static GitHub Pages distribution. Browser CPU/WASM inference, full untrimmed LAFAN-40 motions, independent 0/1/2 kg hand loads, and 2,878 measured latent background points. Nominal physics with observation/reference noise, delays and external pushes disabled. Tracking thresholds do not pause interactive playback; numerical errors still stop it. Reset and manual pause remain available.

The `site/` folder is self-contained. Models and motions use lossless compressed chunks with SHA-256 verification. No training checkpoint files or credentials are included. Model graphs are downloaded by the visitor. Runtime licenses and motion attribution are included in `site/THIRD-PARTY.txt` and `site/vendor/`.

Without cross-origin isolation, inference automatically uses one WASM thread. It never requires GPU inference. All asset URLs are relative so project Pages paths are supported.

Enable Settings → Pages → Source: GitHub Actions, then push main or run the Publish ECHO demo workflow. The workflow publishes only `site/`.

To regenerate in the original workspace, run `python web/echo-live-public/build.py`, copy its `dist/` into `site/`, remove the Cloudflare `_headers` file and retain `.nojekyll`.
