# Telemetry service: OTLP ingestion and trace queries.
# Build from the repository root:
#   docker build -f deploy/docker/telemetry.Dockerfile -t ghcr.io/gallas-ai/extispex-telemetry .
FROM denoland/deno:debian-2.9.5
LABEL org.opencontainers.image.source="https://github.com/gallas-ai/extispex" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1

COPY . .
RUN deno install --frozen \
    && deno cache --frozen services/telemetry/src/main.ts \
    # OpenShift runs containers with an arbitrary user ID in the root group.
    && chgrp -R 0 /app /deno-dir \
    && chmod -R g=u /app /deno-dir

USER 1993
# 4317: OTLP/gRPC, 4318: OTLP/HTTP and trace queries
EXPOSE 4317 4318
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "--allow-sys", "services/telemetry/src/main.ts"]
