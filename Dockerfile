# Build stage: compile TypeScript and native deps
FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: production deps + compiled output only
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# Time zone for "today" and the weekly run. Override with `-e TZ=Europe/Stockholm`, or set the time zone in Settings.
ENV TZ=UTC
# CA bundle for mounted agent CLIs: Node bundles its own roots, but native
# binaries (Copilot CLI and others) read /etc/ssl/certs, which slim lacks
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Stylesheet, vendored HTMX and bundled fonts (served by the app; no CDN, NFR-2)
COPY public ./public
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
