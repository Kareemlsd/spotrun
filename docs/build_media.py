"""Builds the pictures and GIFs used in the README and the walkthrough from
the frames recorded by e2e/demo.mjs.

    python3 docs/build_media.py [frames dir] [output dir]
"""

import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
FRAMES = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "e2e" / "out" / "demo"
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "media"
WIDTH = 1040
BAR = 46


def font(size):
    for candidate in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial.ttf", "C:/Windows/Fonts/segoeui.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def captioned(path, caption, last_caption):
    """The frame scaled to WIDTH with a caption bar underneath. A frame
    without a caption keeps the previous one, so the text does not flicker."""
    image = Image.open(path).convert("RGB")
    height = round(image.height * WIDTH / image.width)
    image = image.resize((WIDTH, height), Image.LANCZOS)
    canvas = Image.new("RGB", (WIDTH, height + BAR), (24, 24, 27))
    canvas.paste(image, (0, 0))
    text = caption or last_caption
    if text:
        draw = ImageDraw.Draw(canvas)
        face = font(19)
        box = draw.textbbox((0, 0), text, font=face)
        while box[2] - box[0] > WIDTH - 32 and face.size > 12:
            face = font(face.size - 1)
            box = draw.textbbox((0, 0), text, font=face)
        draw.text(((WIDTH - (box[2] - box[0])) / 2, height + (BAR - (box[3] - box[1])) / 2 - box[1]), text, font=face, fill=(236, 236, 240))
    return canvas, text


def main():
    manifest = json.loads((FRAMES / "manifest.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for scene, frames in manifest.items():
        images, durations, last = [], [], ""
        for entry in frames:
            image, last = captioned(FRAMES / scene / entry["file"], entry["caption"], last)
            images.append(image)
            durations.append(entry["hold"])
        if len(images) == 1:
            target = OUT / (scene + ".png")
            images[0].save(target, optimize=True)
        else:
            target = OUT / (scene + ".gif")
            # One shared palette keeps colours stable between frames.
            sheet = Image.new("RGB", (WIDTH, images[0].height * min(len(images), 6)))
            for index, image in enumerate(images[:: max(1, len(images) // 6)][:6]):
                sheet.paste(image, (0, index * images[0].height))
            palette = sheet.quantize(colors=128, method=Image.MEDIANCUT)
            quantised = [image.quantize(palette=palette, dither=Image.NONE) for image in images]
            quantised[0].save(target, save_all=True, append_images=quantised[1:], duration=durations, loop=0, optimize=True, disposal=1)
            # A still for places that cannot show animation.
            images[-1].save(OUT / (scene + ".png"), optimize=True)
        print("%-22s %3d frame(s) %7.0f KB" % (target.name, len(images), target.stat().st_size / 1024))


def video():
    """One MP4 with every scene in order, for sharing outside the README."""
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found: skipping the video")
        return
    manifest = json.loads((FRAMES / "manifest.json").read_text())
    with tempfile.TemporaryDirectory() as work:
        work = pathlib.Path(work)
        lines, last_file, count = [], None, 0
        for scene in ("run-and-step", "panel", "describe-inputs", "edge-cases", "write-tests"):
            last = ""
            for entry in manifest.get(scene, []):
                image, last = captioned(FRAMES / scene / entry["file"], entry["caption"], last)
                # H.264 needs even dimensions.
                image = image.crop((0, 0, image.width - image.width % 2, image.height - image.height % 2))
                last_file = work / ("%04d.png" % count)
                image.save(last_file)
                count += 1
                hold = max(entry["hold"], 2600 if scene == "panel" else entry["hold"]) / 1000.0
                lines.append("file '%s'\nduration %.2f" % (last_file, hold))
        lines.append("file '%s'" % last_file)
        (work / "list.txt").write_text("\n".join(lines) + "\n")
        target = OUT / "spotrun-demo.mp4"
        done = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(work / "list.txt"), "-vsync", "vfr", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "23", "-movflags", "+faststart", str(target)],
            capture_output=True,
            text=True,
        )
        if done.returncode != 0:
            print("ffmpeg failed:", done.stderr.strip()[-300:])
            return
        print("%-22s %3d frame(s) %7.0f KB" % (target.name, count, target.stat().st_size / 1024))


if __name__ == "__main__":
    main()
    video()
