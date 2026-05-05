"""Thin HTTP wrapper around Clarity-OMR.

POST /omr with a multipart field named "image" — returns MusicXML.

Clarity-OMR's CLI accepts PDFs only, so image uploads are wrapped into a
single-page PDF in-process using Pillow before invocation.
"""

import os
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from PIL import Image

app = Flask(__name__)
CORS(app)

CLARITY_DIR = Path(os.environ.get("CLARITY_DIR", "/opt/clarity"))
TIMEOUT_SECS = int(os.environ.get("CLARITY_TIMEOUT", "1800"))
DEVICE = os.environ.get("CLARITY_DEVICE", "cpu")  # cpu | cuda | mps
EXTRA_ARGS = os.environ.get("CLARITY_ARGS", "").split()
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def _image_to_pdf(img_path: Path, pdf_path: Path) -> None:
    img = Image.open(img_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    img.save(pdf_path, "PDF", resolution=300.0)


@app.get("/health")
def health():
    return jsonify(status="ok", engine="clarity")


@app.post("/omr")
def omr():
    if "image" not in request.files:
        return jsonify(error="missing 'image' form field"), 400

    upload = request.files["image"]
    suffix = Path(upload.filename or "input.pdf").suffix.lower() or ".pdf"
    if suffix not in IMAGE_EXTS and suffix != ".pdf":
        return jsonify(error=f"unsupported extension {suffix}"), 400

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        in_path = tmp_path / f"input{suffix}"
        pdf_path = tmp_path / "input.pdf"
        out_path = tmp_path / "output.musicxml"
        upload.save(in_path)

        # Clarity accepts PDFs only; wrap images.
        if suffix == ".pdf":
            pdf_path = in_path
        else:
            try:
                _image_to_pdf(in_path, pdf_path)
            except Exception as e:
                return jsonify(error=f"PDF wrap failed: {e}"), 500

        cmd = [
            "python", str(CLARITY_DIR / "omr.py"),
            str(pdf_path),
            "-o", str(out_path),
            "--device", DEVICE,
            *EXTRA_ARGS,
        ]
        try:
            result = subprocess.run(
                cmd,
                cwd=str(CLARITY_DIR),
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="Clarity-OMR timed out"), 504

        if result.returncode != 0:
            app.logger.error("Clarity-OMR failed (rc=%s)", result.returncode)
            app.logger.error("STDOUT:\n%s", result.stdout)
            app.logger.error("STDERR:\n%s", result.stderr)
            return (
                jsonify(
                    error="Clarity-OMR failed",
                    returncode=result.returncode,
                    stderr=result.stderr[-4000:],
                    stdout=result.stdout[-4000:],
                ),
                500,
            )

        # Clarity writes to -o path; also check sibling filename patterns.
        candidates = [out_path] if out_path.exists() else []
        if not candidates:
            candidates = list(tmp_path.glob("*.musicxml")) + list(tmp_path.glob("*.xml"))
        if not candidates:
            return (
                jsonify(
                    error="no MusicXML produced",
                    stdout=result.stdout[-2000:],
                ),
                500,
            )

        out_file = candidates[0]
        return send_file(
            out_file,
            mimetype="application/vnd.recordare.musicxml+xml",
            as_attachment=True,
            download_name=out_file.name,
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8003)
