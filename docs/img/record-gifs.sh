#!/usr/bin/env bash
# Rebuilds the README's two GIFs: status.gif (the website's status window, site/js/status.js,
# playing its scripted night) and mod.gif (the mod's band, terminal-logo.svg). GitHub plays no SVG
# or CSS animation in a README, so the moving pictures are GIFs, and this keeps them rebuildable
# when status.js or the castle changes.
#
# What it settles, each learnt the slow way: frames are screenshots at 2x in a headless browser,
# in Menlo (the site's font subset has no block glyphs, so the castle spilt across rows); the GIF
# is put together by Pillow with one palette for every frame and a duration per frame (ffmpeg's
# fixed frame rate made a 43 MB GIF, and its concat input dropped frames).
#
# Needs agent-browser and uv on PATH. Writes to docs/img unless given another directory.
#
#   bash docs/img/record-gifs.sh [out-dir]
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
out="${1:-$root/docs/img}"
tmp=$(mktemp -d)
mkdir -p "$tmp/st" "$tmp/md" "$out"

cat >"$tmp/status.html" <<EOF
<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="file://$root/site/css/site.css">
<style>html,body{margin:0;background:#0e1116}#w{display:inline-block;padding:14px 18px;background:#0e1116}.status{font-size:14px;background:#0e1116;font-family:Menlo,monospace;line-height:1.16}</style>
<div id="w"><pre class="status"></pre></div>
<script src="file://$root/site/js/status.js"></script>
<script>const {frame,toHTML}=window.SandcastleStatus;window.show=t=>{document.querySelector('.status').innerHTML=toHTML(frame(t,100))};show(0)</script>
EOF

# The status view: one frame per minute of its 32-minute night.
agent-browser open "file://$tmp/status.html" >/dev/null
agent-browser set viewport 1100 900 2 >/dev/null
agent-browser wait 800 >/dev/null
for t in $(seq 0 31); do
  agent-browser eval "show($t)" >/dev/null
  agent-browser screenshot '#w' "$tmp/st/$(printf %02d "$t").png" >/dev/null
done

# The mod's band: square corners and no border, or the rounded corners show white on GitHub's dark
# theme; then its animation paused at every half second of the cycle.
agent-browser open "file://$root/docs/img/terminal-logo.svg" >/dev/null
agent-browser set viewport 760 300 2 >/dev/null
agent-browser wait 300 >/dev/null
agent-browser eval "const r=document.querySelector('rect');r.setAttribute('rx',0);r.setAttribute('x',0);r.setAttribute('y',0);r.setAttribute('width',720);r.setAttribute('height',236);r.removeAttribute('stroke')" >/dev/null
for i in $(seq 0 23); do
  agent-browser eval "document.getAnimations().forEach(a=>{a.pause();a.currentTime=$i*500})" >/dev/null
  agent-browser screenshot 'svg' "$tmp/md/$(printf %02d "$i").png" >/dev/null
done
agent-browser close >/dev/null

cat >"$tmp/gif.py" <<'EOF'
import sys, glob
from PIL import Image
src, out, step, hold = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
frames = [Image.open(f).convert("RGB") for f in sorted(glob.glob(f"{src}/*.png"))]
# One palette from every frame, so colours never shift between frames; no dithering, since a
# terminal's colours are flat.
sheet = Image.new("RGB", (frames[0].width, frames[0].height * len(frames)))
for i, f in enumerate(frames): sheet.paste(f, (0, i * f.height))
pal = sheet.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
durations = [step] * len(q); durations[-1] = hold
q[0].save(out, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=False, disposal=1)
EOF
# The status view holds its last frame (the morning summary) for 7 s before the night restarts.
uv run -q --with pillow python "$tmp/gif.py" "$tmp/st" "$out/status.gif" 1000 7000
uv run -q --with pillow python "$tmp/gif.py" "$tmp/md" "$out/mod.gif" 500 500
ls -l "$out/status.gif" "$out/mod.gif"
rm -rf "$tmp"
