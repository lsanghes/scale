"""Thin HTTP wrapper around Audiveris CLI.

POST /omr with a multipart field named "image" — returns the resulting
MusicXML (.mxl preferred, plain .xml as fallback).
"""

import os
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

AUDIVERIS_BIN = os.environ.get("AUDIVERIS_BIN", "Audiveris")
TIMEOUT_SECS = int(os.environ.get("AUDIVERIS_TIMEOUT", "300"))
# Audiveris rejects sheets above 20M pixels by default. Modern phone photos
# and 300 DPI PDFs routinely exceed that, so bump the ceiling.
MAX_PIXELS = int(os.environ.get("AUDIVERIS_MAX_PIXELS", "120000000"))


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/omr")
def omr():
    if "image" not in request.files:
        return jsonify(error="missing 'image' form field"), 400

    upload = request.files["image"]
    suffix = Path(upload.filename or "input.png").suffix.lower() or ".png"
    if suffix not in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".pdf"}:
        return jsonify(error=f"unsupported extension {suffix}"), 400

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        in_path = tmp_path / f"input{suffix}"
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        upload.save(in_path)

        cmd = [
            AUDIVERIS_BIN,
            "-batch",
            "-constant", f"org.audiveris.omr.step.LoadStep.maxPixelCount={MAX_PIXELS}",
            "-export",
            "-output", str(out_dir),
            "--",
            str(in_path),
        ]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="Audiveris timed out"), 504

        if result.returncode != 0:
            app.logger.error("Audiveris failed (rc=%s)", result.returncode)
            app.logger.error("STDOUT:\n%s", result.stdout)
            app.logger.error("STDERR:\n%s", result.stderr)
            return (
                jsonify(
                    error="Audiveris failed",
                    returncode=result.returncode,
                    stderr=result.stderr[-4000:],
                    stdout=result.stdout[-4000:],
                ),
                500,
            )

        app.logger.info("Audiveris ok; stdout tail:\n%s", result.stdout[-1500:])

        # Prefer compressed .mxl, fall back to .xml/.musicxml
        candidates = (
            list(out_dir.rglob("*.mxl"))
            + list(out_dir.rglob("*.musicxml"))
            + list(out_dir.rglob("*.xml"))
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
    app.run(host="0.0.0.0", port=8001)
