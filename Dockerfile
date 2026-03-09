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
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN echo "cache-bust: ${CACHE_BUST}" \
 && git clone "${OPENFANG_REPO}" source \
 && cd source \
 && git checkout "${OPENFANG_REF}" \
 && cargo build --release --bin openfang


FROM node:22-bookworm-slim

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

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
COPY --from=builder /build/source/target/release/openfang /usr/local/bin/openfang
COPY --from=builder /build/source/agents /opt/openfang/agents

RUN groupadd --system openfang \
 && useradd --system --create-home --gid openfang openfang \
 && mkdir -p /data \
 && chown -R openfang:openfang /app /data /opt/openfang

ENV NODE_ENV=production
ENV PORT=8080
ENV OPENFANG_HOME=/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
 CMD curl -fsS http://127.0.0.1:8080/setup/healthz || exit 1

ENTRYPOINT ["./entrypoint.sh"]
