# Chrono headless server (web UI + API) — multi-stage build.
#
#   docker build -t chrono .
#   docker run -d -p 1421:1421 -e CHRONO_API_TOKEN=$(openssl rand -hex 24) \
#     -v $HOME/src:/repos chrono
#   then open http://localhost:1421 and enter the token.
#
# Repositories are opened by their path inside the container (e.g. /repos/app).

FROM node:26-bookworm-slim AS build
WORKDIR /app
# node-pty is a native module: it needs a toolchain to compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Chrono" \
      org.opencontainers.image.description="GitKraken-style Git client with a TortoiseGit-style explorer — headless web server" \
      org.opencontainers.image.source="https://github.com/xsession/chrono" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs openssh-client ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
RUN mkdir -p /repos /config && chown -R node:node /repos /config
USER node
ENV CHRONO_HOST=0.0.0.0 \
    CHRONO_PORT=1421 \
    CHRONO_CONFIG_DIR=/config \
    NODE_ENV=production
EXPOSE 1421
VOLUME ["/repos", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:1421/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "server/index.ts"]
