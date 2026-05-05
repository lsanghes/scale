# Audiveris OMR service
# Stage 1: build Audiveris from source
FROM eclipse-temurin:25-jdk AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# Pin to the active development branch — Audiveris uses `development` as its
# main line. Use a shallow clone to keep the image small.
ARG AUDIVERIS_REF=development
RUN git clone --depth 1 --branch "${AUDIVERIS_REF}" https://github.com/Audiveris/audiveris.git .

# Build the runnable distribution. Skip tests to shave several minutes.
RUN ./gradlew --no-daemon :app:build -x test

# The gradle build emits a distribution tar in app/build/distributions/.
# Name depends on the subproject/version (e.g. app-5.10.1.tar), so locate it.
RUN set -e && \
    ls -la app/build/distributions/ && \
    TAR=$(ls app/build/distributions/*.tar | head -n1) && \
    echo "Extracting $TAR" && \
    mkdir -p /opt/audiveris && \
    tar -xf "$TAR" -C /opt/audiveris --strip-components=1 && \
    ls /opt/audiveris/bin

# Stage 2: runtime
FROM eclipse-temurin:25-jre

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      libfreetype6 \
      fontconfig \
      python3 \
      python3-flask \
      python3-flask-cors \
    && rm -rf /var/lib/apt/lists/*

ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata/

COPY --from=builder /opt/audiveris /opt/audiveris
ENV PATH="/opt/audiveris/bin:${PATH}"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8001
CMD ["python3", "/app/server.py"]
