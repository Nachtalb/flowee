# syntax=docker/dockerfile:1
# Flowee self-hosted: one executable (`bun build --compile`, the served material embedded) on an empty image with
# only what it loads: the musl loader, libstdc++ and libgcc_s (bun's compiled executables are not fully static) and
# the CA bundle for HTTPS to Telegram, GitHub and GitLab. Multi-arch: docker buildx build --platform
# linux/amd64,linux/arm64 -t flowee . (docs/self-hosting.md).
ARG BUN_VERSION=1.4.5

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
COPY . .
ARG TARGETARCH
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) \
 && bun scripts/compile.ts --target "bun-linux-$arch-musl" --outfile /out/flowee

# the target architecture's runtime libraries and CA bundle
FROM alpine:3 AS libs
RUN apk add --no-cache libstdc++ ca-certificates \
 && mkdir -p /root-fs/lib /root-fs/usr/lib /root-fs/etc/ssl/certs /root-fs/data \
 && cp /lib/ld-musl-*.so.1 /root-fs/lib/ \
 && cp /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /root-fs/usr/lib/ \
 && cp /etc/ssl/certs/ca-certificates.crt /root-fs/etc/ssl/certs/ \
 && chown 65532:65532 /root-fs/data

FROM scratch
COPY --from=libs /root-fs/ /
COPY --from=build /out/flowee /flowee
# the licence texts of what the image redistributes (licenses/NOTICE.txt)
COPY licenses/ LICENSE /licenses/
USER 65532:65532
ENV FLOWEE_DATA=/data FLOWEE_PORT=8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/flowee", "health"]
ENTRYPOINT ["/flowee"]
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Flowee" \
      org.opencontainers.image.description="Ticket flow for AI agent teams, with a Telegram envoy for the human in the loop (self-hosted)" \
      org.opencontainers.image.source="https://github.com/Nachtalb/flowee" \
      org.opencontainers.image.url="https://github.com/Nachtalb/flowee" \
      org.opencontainers.image.documentation="https://github.com/Nachtalb/flowee/blob/main/docs/self-hosting.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Nachtalb <na@nachtalb.io>" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
