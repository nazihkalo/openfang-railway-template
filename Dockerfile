# syntax=docker/dockerfile:1

FROM rust:1-slim-bookworm AS builder

ARG OPENFANG_REPO=https://github.com/RightNow-AI/openfang.git
ARG OPENFANG_REF=main
ARG CACHE_BUST=1

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    libssl-dev \
    pkg-config \
    clang \
    libclang-dev \
    cmake \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN echo "cache-bust: ${CACHE_BUST}" \
 && git clone "${OPENFANG_REPO}" source \
 && cd source \
 && git checkout "${OPENFANG_REF}" \
 && cargo build --workspace --release


FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gosu \
    libssl3 \
    procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/source/target/release/openfang /usr/local/bin/openfang

RUN groupadd --system openfang \
 && useradd --system --create-home --gid openfang openfang \
 && mkdir -p /data/agents \
 && chown -R openfang:openfang /app /data

COPY --from=builder --chown=openfang:openfang /build/source/agents /data/agents

ENV OPENFANG_HOME=/data
ENV PORT=4200

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -fsS http://127.0.0.1:4200/api/health || exit 1

USER openfang

ENTRYPOINT ["/usr/local/bin/openfang", "start", "--host", "0.0.0.0", "--port", "4200"]
