# Clarity-OMR service.
# https://github.com/clquwu/Clarity-OMR (GPL-3.0)
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ARG CLARITY_REF=main
RUN git clone --depth 1 --branch "${CLARITY_REF}" \
      https://github.com/clquwu/Clarity-OMR.git /opt/clarity

WORKDIR /opt/clarity

# CPU-only torch from the official PyTorch wheel index keeps the image small.
# If you want GPU, override with --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch torchvision --index-url "${TORCH_INDEX}" \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir flask flask-cors

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8003
CMD ["python", "/app/server.py"]
