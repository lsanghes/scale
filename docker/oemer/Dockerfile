# oemer OMR service.
# https://github.com/BreezeWhite/oemer
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      libgl1 \
      libglib2.0-0 \
      curl \
    && rm -rf /var/lib/apt/lists/*

# oemer pulls in onnxruntime + opencv + scikit-image etc. Pin to the latest
# version published on PyPI at image build time. Override with --build-arg
# if upstream breaks.
ARG OEMER_VERSION=
RUN pip install --no-cache-dir "oemer${OEMER_VERSION:+==${OEMER_VERSION}}" flask flask-cors pdf2image

# oemer 0.1.x still references np.int / np.float etc., which were removed in
# NumPy 1.24. Its opencv-python dep pulls in numpy>=2, so we can't just pin
# numpy low. Patch the two known call sites instead.
RUN python -c "import oemer, pathlib; print(pathlib.Path(oemer.__file__).parent)" > /tmp/oemer-path \
    && OEMER_DIR=$(cat /tmp/oemer-path) \
    && sed -i 's/np\.int\b/int/g' "$OEMER_DIR/staffline_extraction.py" "$OEMER_DIR/symbol_extraction.py" \
    && echo "--- patched lines ---" \
    && grep -nE "np\.(int|float|bool)\b" "$OEMER_DIR"/*.py || echo "(none remaining)"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8002
CMD ["python", "/app/server.py"]
