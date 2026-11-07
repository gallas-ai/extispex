# Identity service: Projects and Project API keys.
# Build from the repository root:
#   docker build -f deploy/docker/identity.Dockerfile -t ghcr.io/gallas-ai/extispex-identity .
FROM denoland/deno:debian-2.9.5
LABEL org.opencontainers.image.source="https://github.com/gallas-ai/extispex" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1

COPY . .
RUN deno install --frozen \
    && deno cache --frozen services/identity/src/main.ts \
    # OpenShift runs containers with an arbitrary user ID in the root group.
    && chgrp -R 0 /app /deno-dir \
    && chmod -R g=u /app /deno-dir

USER 1993
# 8082: Project and API key management, and API key resolution for the other services
EXPOSE 8082
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "--allow-sys", "services/identity/src/main.ts"]
