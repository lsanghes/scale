"""Thin HTTP wrapper around the oemer CLI.

POST /omr with a multipart field named "image" (PNG/JPG/TIFF/PDF) — returns
the resulting MusicXML.

PDFs are rasterized to a single PNG at 300 DPI (first page only) before being
handed to oemer, since oemer consumes image files, not PDFs.
"""

import os
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

OEMER_BIN = os.environ.get("OEMER_BIN", "oemer")
TIMEOUT_SECS = int(os.environ.get("OEMER_TIMEOUT", "900"))
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def _rasterize_pdf(pdf_path: Path, out_dir: Path) -> Path:
    """Convert first page of PDF to PNG using poppler (pdftoppm)."""
    prefix = out_dir / "page"
    subprocess.run(
        ["pdftoppm", "-r", "300", "-png", "-f", "1", "-l", "1",
         str(pdf_path), str(prefix)],
        check=True, capture_output=True,
    )
    pages = sorted(out_dir.glob("page-*.png"))
    if not pages:
        raise RuntimeError("pdftoppm produced no output")
    return pages[0]


@app.get("/health")
def health():
    return jsonify(status="ok", engine="oemer")


@app.post("/omr")
def omr():
    if "image" not in request.files:
        return jsonify(error="missing 'image' form field"), 400

    upload = request.files["image"]
    suffix = Path(upload.filename or "input.png").suffix.lower() or ".png"
    if suffix not in IMAGE_EXTS and suffix != ".pdf":
        return jsonify(error=f"unsupported extension {suffix}"), 400

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        in_path = tmp_path / f"input{suffix}"
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        upload.save(in_path)

        # Convert PDFs to images for oemer.
        if suffix == ".pdf":
            try:
                in_path = _rasterize_pdf(in_path, tmp_path)
            except Exception as e:
                return jsonify(error=f"PDF rasterization failed: {e}"), 500

        cmd = [OEMER_BIN, "-o", str(out_dir), str(in_path)]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="oemer timed out"), 504

        if result.returncode != 0:
            app.logger.error("oemer failed (rc=%s)", result.returncode)
            app.logger.error("STDOUT:\n%s", result.stdout)
            app.logger.error("STDERR:\n%s", result.stderr)
            return (
                jsonify(
                    error="oemer failed",
                    returncode=result.returncode,
                    stderr=result.stderr[-4000:],
                    stdout=result.stdout[-4000:],
                ),
                500,
            )

        candidates = (
            list(out_dir.rglob("*.musicxml"))
            + list(out_dir.rglob("*.xml"))
            + list(out_dir.rglob("*.mxl"))
        )
        if not candidates:
            return (
                jsonify(
                    error="no MusicXML produced",
                    stdout=result.stdout[-2000:],
                ),
                500,
            )

        out_file = candidates[0]
        mimetype = (
            "application/vnd.recordare.musicxml"
            if out_file.suffix == ".mxl"
            else "application/vnd.recordare.musicxml+xml"
        )
        return send_file(
            out_file,
            mimetype=mimetype,
            as_attachment=True,
            download_name=out_file.name,
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8002)
