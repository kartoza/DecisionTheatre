# syntax=docker/dockerfile:1

FROM node:22-bookworm AS frontend
WORKDIR /src/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM golang:1.24-bookworm AS builder
WORKDIR /src

ARG VERSION=dev
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gcc \
        git \
        libgtk-3-dev \
        libwebkit2gtk-4.0-dev \
        pkg-config \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY go.mod go.sum ./
RUN go mod edit -dropreplace github.com/webview/webview_go \
    && go mod download

COPY . .
RUN go mod edit -dropreplace github.com/webview/webview_go

COPY --from=frontend /src/frontend/dist ./frontend/dist
RUN rm -rf internal/server/static \
    && mkdir -p internal/server/static \
    && cp -r frontend/dist/* internal/server/static/

RUN python3 -m venv /tmp/mkdocs \
    && /tmp/mkdocs/bin/pip install --no-cache-dir \
        mkdocs \
        mkdocs-material \
        mkdocs-minify-plugin \
        pygments \
        pymdown-extensions \
    && /tmp/mkdocs/bin/mkdocs build -d internal/server/docs_site

RUN CGO_ENABLED=1 go build \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/decision-theatre .


FROM debian:bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        jq \
        libgtk-3-0 \
        libwebkit2gtk-4.0-37 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /out/decision-theatre /usr/local/bin/decision-theatre

RUN mkdir -p /app/data /app/resources

EXPOSE 8080 8081 8082 8083

ENTRYPOINT ["decision-theatre"]
CMD ["--headless", "--port", "8080", "--data-dir", "/app/data", "--resources-dir", "/app/resources"]
