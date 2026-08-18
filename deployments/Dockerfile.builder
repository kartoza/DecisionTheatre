# syntax=docker/dockerfile:1

# Toolchain image for the `builder` service in docker-compose.yaml.
#
# Lets `make pack-data` and `scripts/build-cross-docker.sh` run as part of the
# Docker deployment, so the production host only needs Docker Engine — not
# Nix, Go, Node or Python. The repo (and the DT_DATA_DIR data directory) are
# bind-mounted in at run time by docker-compose.yaml; this image supplies
# only the toolchain, never the source or its build output. Their output
# (the data pack zip, the cross-compiled executables) is written to the
# decision-theatre-dist volume, not into this image.
#
# The Docker CLI + Compose plugin are needed because build-cross-docker.sh
# itself shells out to `docker build`/`docker compose`/`docker exec` — those
# reach the host daemon via the socket docker-compose.yaml mounts in.

FROM golang:1.25-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gcc \
        git \
        gnupg \
        jq \
        libgtk-3-dev \
        libwebkit2gtk-4.0-dev \
        make \
        pkg-config \
        python3 \
        python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/mkdocs \
    && /opt/mkdocs/bin/pip install --no-cache-dir \
        mkdocs \
        mkdocs-macros-plugin \
        mkdocs-material \
        mkdocs-minify-plugin \
        pygments \
        pymdown-extensions
ENV PATH="/opt/mkdocs/bin:${PATH}"

COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# The repo is bind-mounted from the host, so its owner UID almost never
# matches this image's root user; git refuses to touch it ("dubious
# ownership") without this. scripts/version.sh swallows that failure and
# silently falls back to a "dev" version label, so without this every pack
# and executable built here would be mislabeled.
RUN git config --global --add safe.directory '*'

WORKDIR /src
