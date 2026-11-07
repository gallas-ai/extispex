# Gateway: serves the web UI and forwards REST requests to the services.
# Build from the repository root:
#   docker build -f deploy/docker/gateway.Dockerfile -t ghcr.io/gallas-ai/extispex-gateway .
FROM denoland/deno:debian-2.9.5

WORKDIR /app
ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1 \
    WEB_ASSETS_DIRECTORY=/app/apps/web/dist

COPY . .
RUN deno install --frozen \
    && deno task build:web \
    && deno cache --frozen services/gateway/src/main.ts \
    # OpenShift runs containers with an arbitrary user ID in the root group.
    && chgrp -R 0 /app /deno-dir \
    && chmod -R g=u /app /deno-dir

USER 1993
EXPOSE 8080
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "services/gateway/src/main.ts"]
