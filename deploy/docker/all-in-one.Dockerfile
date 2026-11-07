# Local deployment: every service in one process, with SQLite files in /data.
# Build from the repository root:
#   docker build -f deploy/docker/all-in-one.Dockerfile -t ghcr.io/gallas-ai/extispex .
FROM denoland/deno:debian-2.9.5
LABEL org.opencontainers.image.source="https://github.com/gallas-ai/extispex" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1 \
    DATA_DIRECTORY=/data \
    WEB_ASSETS_DIRECTORY=/app/apps/web/dist

COPY . .
RUN deno install --frozen \
    && deno task build:web \
    && deno cache --frozen apps/all-in-one/src/main.ts \
    && mkdir -p /data \
    # OpenShift runs containers with an arbitrary user ID in the root group.
    && chgrp -R 0 /app /deno-dir /data \
    && chmod -R g=u /app /deno-dir /data

USER 1993
VOLUME /data
# 4317: OTLP/gRPC, 4318: OTLP/HTTP, 8080: UI and REST API
EXPOSE 4317 4318 8080
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "--allow-sys", "apps/all-in-one/src/main.ts"]
